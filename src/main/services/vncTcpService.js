import net from "node:net";
import { EventEmitter } from "node:events";

const DEFAULT_HOST = "192.168.1.6";
const DEFAULT_PORT = 5901;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_TAP_DELAY_MS = 12;
const MIN_TAP_DELAY_MS = 1;
const MAX_TAP_DELAY_MS = 100;
const RFB_VERSION = "RFB 003.008\n";

const SPECIAL_KEYSYM = new Map([
	["shift", 0xffe1],
	["shiftleft", 0xffe1],
	["shiftright", 0xffe2],
	["ctrl", 0xffe3],
	["control", 0xffe3],
	["controlleft", 0xffe3],
	["controlright", 0xffe4],
	["alt", 0xffe9],
	["altleft", 0xffe9],
	["altright", 0xffea],
	["meta", 0xffeb],
	["cmd", 0xffeb],
	["super", 0xffeb],
	["win", 0xffeb],
	["arrowup", 0xff52],
	["up", 0xff52],
	["arrowdown", 0xff54],
	["down", 0xff54],
	["arrowleft", 0xff51],
	["left", 0xff51],
	["arrowright", 0xff53],
	["right", 0xff53],
	["home", 0xff50],
	["end", 0xff57],
	["pageup", 0xff55],
	["pagedown", 0xff56],
	["enter", 0xff0d],
	["return", 0xff0d],
	["backspace", 0xff08],
	["delete", 0xffff],
	["insert", 0xff63],
	["tab", 0xff09],
	["space", 0x0020],
	[" ", 0x0020],
	["escape", 0xff1b],
	["esc", 0xff1b],
	["capslock", 0xffe5],
	["numlock", 0xff7f],
	["scrolllock", 0xff14],
	["pause", 0xff13],
	["printscreen", 0xff61],
	["contextmenu", 0xff67],
	["menu", 0xff67],
	["f1", 0xffbe],
	["f2", 0xffbf],
	["f3", 0xffc0],
	["f4", 0xffc1],
	["f5", 0xffc2],
	["f6", 0xffc3],
	["f7", 0xffc4],
	["f8", 0xffc5],
	["f9", 0xffc6],
	["f10", 0xffc7],
	["f11", 0xffc8],
	["f12", 0xffc9],
	["f13", 0xffca],
	["f14", 0xffcb],
	["f15", 0xffcc],
	["f16", 0xffcd],
	["f17", 0xffce],
	["f18", 0xffcf],
	["f19", 0xffd0],
	["f20", 0xffd1],
]);

export function normalizeVncTcpConfig(input = {}) {
	const host = String(input.host ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
	const port = Number(input.port ?? DEFAULT_PORT);
	const tapDelayMs = Number(input.tapDelayMs ?? DEFAULT_TAP_DELAY_MS);

	return {
		host,
		port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
		enabled: input.enabled === true,
		tapDelayMs: Number.isFinite(tapDelayMs)
			? Math.min(MAX_TAP_DELAY_MS, Math.max(MIN_TAP_DELAY_MS, Math.round(tapDelayMs)))
			: DEFAULT_TAP_DELAY_MS,
	};
}

export function keyToKeysym(key) {
	if (typeof key !== "string") {
		return null;
	}

	const value = key.trim();
	if (value.length === 0) {
		return null;
	}

	if (value.length === 1) {
		const codePoint = value.codePointAt(0);
		if ((codePoint >= 0x0020 && codePoint <= 0x007e) || (codePoint >= 0x00a0 && codePoint <= 0x00ff)) {
			return codePoint;
		}
		return 0x01000000 | codePoint;
	}

	return SPECIAL_KEYSYM.get(value.toLowerCase()) ?? null;
}

export function createRfbKeyEvent(keysym, down) {
	const message = Buffer.alloc(8);
	message.writeUInt8(4, 0);
	message.writeUInt8(down ? 1 : 0, 1);
	message.writeUInt16BE(0, 2);
	message.writeUInt32BE(keysym >>> 0, 4);
	return message;
}

export function createTcpWordPacket(word) {
	return Buffer.from(String(word ?? ""), "utf8");
}

export class VncTcpService extends EventEmitter {
	constructor(configService) {
		super();
		this.configService = configService;
		this.socket = null;
		this.buffer = Buffer.alloc(0);
		this.pendingReads = [];
		this.tapTimers = new Set();
		this.tapQueues = new Map();
		this.tapGeneration = 0;
		this.activeKeysyms = new Set();
		this.state = {
			status: "disconnected",
			message: "Disconnected",
			host: this.config.host,
			port: this.config.port,
			tapDelayMs: this.config.tapDelayMs,
			desktopName: "",
			width: 0,
			height: 0,
			securityTypes: [],
			serverVersion: "",
		};
	}

	get config() {
		return normalizeVncTcpConfig(this.configService.value.vncTcp);
	}

	get isConnected() {
		return this.state.status === "connected" && this.socket && !this.socket.destroyed;
	}

	shouldUseTcpOutput() {
		return this.config.enabled === true;
	}

	getState() {
		return {
			...this.state,
			enabled: this.config.enabled,
			tapDelayMs: this.config.tapDelayMs,
		};
	}

	updateSettings(partial) {
		const next = normalizeVncTcpConfig({
			...this.config,
			...partial,
		});
		this.configService.updateVncTcp(next);

		const statePatch = {
			tapDelayMs: next.tapDelayMs,
		};

		if (!this.isConnected) {
			statePatch.host = next.host;
			statePatch.port = next.port;
		}

		this.#setState(statePatch);
		return this.getState();
	}

	async connect(input = {}) {
		const next = normalizeVncTcpConfig({
			...this.config,
			...input,
			enabled: true,
		});
		this.configService.updateVncTcp(next);
		this.disconnect({ silent: true });
		this.#log(`Connecting to ${next.host}:${next.port}`);

		const socket = new net.Socket();
		socket.setNoDelay(true);
		const onData = (chunk) => {
			if (this.socket === socket) {
				this.#onData(chunk);
			}
		};

		socket.on("data", onData);
		socket.on("error", (error) => {
			if (this.socket !== socket) {
				return;
			}

			this.#rejectPending(error);
			this.#setState({
				status: "error",
				message: error.message,
			});
		});
		socket.on("close", () => {
			socket.off("data", onData);
			if (this.socket !== socket) {
				return;
			}

			this.#rejectPending(new Error("Connection closed"));
			this.socket = null;
			this.#cancelTapQueues();
			this.activeKeysyms.clear();
			if (this.state.status !== "error") {
				this.#setState({
					status: "disconnected",
					message: "Disconnected",
				});
			}
		});

		this.socket = socket;
		this.buffer = Buffer.alloc(0);
		this.pendingReads = [];
		this.#setState({
			status: "connecting",
			message: `Connecting to ${next.host}:${next.port}...`,
			host: next.host,
			port: next.port,
			tapDelayMs: next.tapDelayMs,
			desktopName: "",
			width: 0,
			height: 0,
			securityTypes: [],
			serverVersion: "",
		});

		try {
			await this.#connectSocket(socket, next.host, next.port);
			const desktop = await this.#withTimeout(
				this.#handshake(socket),
				DEFAULT_TIMEOUT_MS,
				"RFB handshake timed out",
			);

			if (this.socket !== socket) {
				throw new Error("Connection was replaced");
			}

			this.#setState({
				status: "connected",
				message: desktop.desktopName
					? `Connected to ${desktop.desktopName}`
					: `Connected to ${next.host}:${next.port}`,
				...desktop,
			});
			this.#log(
				desktop.desktopName
					? `Connected: ${desktop.desktopName} (${desktop.width}x${desktop.height})`
					: `Connected to ${next.host}:${next.port}`,
				"success",
			);
		} catch (error) {
			if (this.socket === socket) {
				this.socket = null;
			}
			socket.destroy();
			this.#rejectPending(error);
			this.#cancelTapQueues();
			this.activeKeysyms.clear();
			this.#setState({
				status: "error",
				message: error.message,
				host: next.host,
				port: next.port,
			});
			this.#log(`Connection failed: ${error.message}`, "error");
		}

		return this.getState();
	}

	disconnect({ silent = false } = {}) {
		const wasConnected = this.isConnected;

		if (this.socket && !this.socket.destroyed) {
			this.releaseAll();
			this.socket.destroy();
		}

		this.socket = null;
		this.buffer = Buffer.alloc(0);
		this.#rejectPending(new Error("Disconnected"));
		this.activeKeysyms.clear();

		if (!silent) {
			this.#setState({
				status: "disconnected",
				message: "Disconnected",
			});
			this.#log(wasConnected ? "Disconnected" : "TCP stopped");
		}

		return this.getState();
	}

	releaseAll() {
		this.#cancelTapQueues();
		if (!this.socket || this.socket.destroyed) {
			this.activeKeysyms.clear();
			return;
		}

		for (const keysym of [...this.activeKeysyms]) {
			this.#writeKeyEvent(keysym, false);
		}
		this.activeKeysyms.clear();
	}

	sendKey(key, down) {
		if (!this.config.enabled || !this.isConnected) {
			return false;
		}

		const keysym = keyToKeysym(key);
		if (keysym === null) {
			return false;
		}

		const isDown = down === true;
		return this.#writeKeyEvent(keysym, isDown);
	}

	tapKey(key, durationMs) {
		if (!this.config.enabled || !this.isConnected) {
			return false;
		}

		const keysym = keyToKeysym(key);
		if (keysym === null) {
			return false;
		}

		this.#queueKeyTap(keysym, durationMs);
		return true;
	}

	/**
	 * Send a raw UTF-8 word packet to the TCP connection. This is intended
	 * for simple application-level commands when the remote server expects
	 * plain text messages. Use with caution against standard RFB servers.
	 *
	 * @param {string} word
	 * @returns {boolean}
	 */
	sendWord(word) {
		if (!this.config.enabled || !this.isConnected) {
			return false;
		}

		if (!this.socket || this.socket.destroyed) {
			return false;
		}

		try {
			this.socket.write(createTcpWordPacket(word));
			this.#log(`Sent TCP word packet: ${String(word)}`, "info");
			return true;
		} catch (error) {
			this.#log(`Failed to send TCP word packet: ${error?.message ?? error}`, "error");
			return false;
		}
	}

	#writeKeyEvent(keysym, down) {
		if (!this.socket || this.socket.destroyed) {
			return false;
		}

		this.socket.write(createRfbKeyEvent(keysym, down));
		if (down) {
			this.activeKeysyms.add(keysym);
		} else {
			this.activeKeysyms.delete(keysym);
		}

		return true;
	}

	#decodeRawRect(width, height, pixelFormat, data) {
		if (!pixelFormat || !pixelFormat.trueColorFlag) {
			throw new Error("Unsupported pixel format for raw capture");
		}

		const bytesPerPixel = pixelFormat.bitsPerPixel / 8;
		if (![3, 4].includes(bytesPerPixel)) {
			throw new Error(`Unsupported bytesPerPixel: ${bytesPerPixel}`);
		}

		const output = Buffer.alloc(width * height * 4);
		const rowBytes = width * bytesPerPixel;

		for (let y = 0; y < height; y++) {
			const rowStart = y * rowBytes;
			for (let x = 0; x < width; x++) {
				const pixelStart = rowStart + x * bytesPerPixel;
				let pixelValue = 0;
				if (bytesPerPixel === 4) {
					pixelValue = pixelFormat.bigEndianFlag
						? data.readUInt32BE(pixelStart)
						: data.readUInt32LE(pixelStart);
				} else {
					const b0 = data.readUInt8(pixelStart);
					const b1 = data.readUInt8(pixelStart + 1);
					const b2 = data.readUInt8(pixelStart + 2);
					pixelValue = pixelFormat.bigEndianFlag
						? (b0 << 16) | (b1 << 8) | b2
						: b0 | (b1 << 8) | (b2 << 16);
				}

				const red = Math.round(((pixelValue >> pixelFormat.redShift) & pixelFormat.redMax) * 255 / pixelFormat.redMax);
				const green = Math.round(((pixelValue >> pixelFormat.greenShift) & pixelFormat.greenMax) * 255 / pixelFormat.greenMax);
				const blue = Math.round(((pixelValue >> pixelFormat.blueShift) & pixelFormat.blueMax) * 255 / pixelFormat.blueMax);

				const destIndex = (y * width + x) * 4;
				output[destIndex] = red;
				output[destIndex + 1] = green;
				output[destIndex + 2] = blue;
				output[destIndex + 3] = 255;
			}
		}

		return output;
	}

	async captureScreenshot() {
		if (!this.config.enabled || !this.isConnected) {
			return { success: false, error: "VNC is not connected" };
		}

		const width = this.state.width;
		const height = this.state.height;
		const pixelFormat = this.serverPixelFormat;
		if (!pixelFormat) {
			return { success: false, error: "Server pixel format not available" };
		}

		this.#sendSetEncodings([0]);

		const request = Buffer.alloc(10);
		request.writeUInt8(3, 0);
		request.writeUInt8(0, 1);
		request.writeUInt16BE(0, 2);
		request.writeUInt16BE(0, 4);
		request.writeUInt16BE(width, 6);
		request.writeUInt16BE(height, 8);
		this.socket.write(request);

		const header = await this.#readBytes(4);
		const messageType = header.readUInt8(0);
		if (messageType !== 0) {
			return { success: false, error: `Unexpected VNC message type ${messageType}` };
		}

		const numberOfRectangles = header.readUInt16BE(2);
		const fullImage = Buffer.alloc(width * height * 4);

		for (let i = 0; i < numberOfRectangles; i++) {
			const rectHeader = await this.#readBytes(12);
			const x = rectHeader.readUInt16BE(0);
			const y = rectHeader.readUInt16BE(2);
			const w = rectHeader.readUInt16BE(4);
			const h = rectHeader.readUInt16BE(6);
			const encoding = rectHeader.readInt32BE(8);

			if (encoding !== 0) {
				return { success: false, error: `Unsupported encoding ${encoding}, only raw is supported` };
			}

			const bytesPerPixel = pixelFormat.bitsPerPixel / 8;
			const rectSize = w * h * bytesPerPixel;
			const rawData = await this.#readBytes(rectSize);
			const decoded = this.#decodeRawRect(w, h, pixelFormat, rawData);

			for (let row = 0; row < h; row++) {
				const srcStart = row * w * 4;
				const dstStart = ((y + row) * width + x) * 4;
			
decoded.copy(fullImage, dstStart, srcStart, srcStart + w * 4);
			}
		}

		return {
			success: true,
			width,
			height,
			image: fullImage.toString("base64"),
		};
	}

	tapAt(x, y, durationMs) {
		if (!this.config.enabled || !this.isConnected) {
			return false;
		}

		return this.#queuePointerTap(x, y, durationMs);
	}

	#getKeyBinding(key) {
		return this.configService.value.vncBindings?.[key] ?? null;
	}

	tapKey(key, durationMs) {
		const binding = this.#getKeyBinding(key);
		if (binding) {
			return this.tapAt(binding.x, binding.y, durationMs);
		}

		if (!this.config.enabled || !this.isConnected) {
			return false;
		}

		const keysym = keyToKeysym(key);
		if (keysym === null) {
			return false;
		}

		this.#queueKeyTap(keysym, durationMs);
		return true;
	}

	sendKey(key, down) {
		const binding = this.#getKeyBinding(key);
		if (binding && down) {
			return this.tapAt(binding.x, binding.y, this.config.tapDelayMs);
		}

		if (!this.config.enabled || !this.isConnected) {
			return false;
		}

		const keysym = keyToKeysym(key);
		if (keysym === null) {
			return false;
		}

		const isDown = down === true;
		return this.#writeKeyEvent(keysym, isDown);
	}

	#queueKeyTap(keysym, durationMs) {
		const generation = this.tapGeneration;
		let queue = this.tapQueues.get(keysym);
		if (!queue) {
			queue = {
				generation,
				pending: [],
				running: false,
			};
			this.tapQueues.set(keysym, queue);
		}

		queue.pending.push(durationMs);
		if (!queue.running) {
			this.#drainTapQueue(keysym, queue);
		}
	}

	#drainTapQueue(keysym, queue) {
		if (queue.running) {
			return;
		}

		queue.running = true;
		const runNext = () => {
			if (queue.generation !== this.tapGeneration || queue.pending.length <= 0) {
				this.tapQueues.delete(keysym);
				return;
			}

			const nextDuration = queue.pending.shift();
			if (!this.#canWriteTap(queue.generation)) {
				this.tapQueues.delete(keysym);
				return;
			}

			this.#writeKeyEvent(keysym, true);
			const delayMs = typeof nextDuration === "number" && Number.isFinite(nextDuration) && nextDuration > 0
				? Math.max(1, Math.round(nextDuration))
				: this.config.tapDelayMs;
			this.#setTapTimer(() => {
				if (this.#canWriteTap(queue.generation)) {
					this.#writeKeyEvent(keysym, false);
				}
				runNext();
			}, delayMs);
		};

		runNext();
	}

	#canWriteTap(generation) {
		return generation === this.tapGeneration && this.isConnected;
	}

	#setTapTimer(callback, delayMs) {
		const entry = {
			timer: null,
		};
		entry.timer = setTimeout(() => {
			this.tapTimers.delete(entry);
			callback();
		}, delayMs);
		this.tapTimers.add(entry);
	}

	#cancelTapQueues() {
		this.tapGeneration += 1;
		for (const entry of this.tapTimers) {
			clearTimeout(entry.timer);
		}
		this.tapTimers.clear();
		this.tapQueues.clear();
	}

	#parsePixelFormat(buffer) {
		return {
			bitsPerPixel: buffer.readUInt8(0),
			depth: buffer.readUInt8(1),
			bigEndianFlag: buffer.readUInt8(2) === 1,
			trueColorFlag: buffer.readUInt8(3) === 1,
			redMax: buffer.readUInt16BE(4),
			greenMax: buffer.readUInt16BE(6),
			blueMax: buffer.readUInt16BE(8),
			redShift: buffer.readUInt8(10),
			greenShift: buffer.readUInt8(11),
			blueShift: buffer.readUInt8(12),
		};
	}

	#sendSetEncodings(encodings = [0]) {
		if (!this.socket || this.socket.destroyed) {
			return false;
		}

		const buffer = Buffer.alloc(4 + encodings.length * 4);
		buffer.writeUInt8(2, 0);
		buffer.writeUInt8(0, 1);
		buffer.writeUInt16BE(encodings.length, 2);
		encodings.forEach((encoding, index) => {
			buffer.writeInt32BE(encoding, 4 + index * 4);
		});
		this.socket.write(buffer);
		return true;
	}

	#writePointerEvent(buttonMask, x, y) {
		if (!this.socket || this.socket.destroyed) {
			return false;
		}

		const message = Buffer.alloc(6);
		message.writeUInt8(5, 0);
		message.writeUInt8(buttonMask, 1);
		message.writeUInt16BE(x, 2);
		message.writeUInt16BE(y, 4);
		this.socket.write(message);
		return true;
	}

	#queuePointerTap(x, y, durationMs) {
		if (!this.socket || this.socket.destroyed) {
			return false;
		}

		const wait = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
			? Math.max(1, Math.round(durationMs))
			: this.config.tapDelayMs;

		this.#writePointerEvent(1, x, y);
		this.#setTapTimer(() => {
			this.#writePointerEvent(0, x, y);
		}, wait);
		return true;
	}

	#connectSocket(socket, host, port) {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`Connection timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`));
			}, DEFAULT_TIMEOUT_MS);

			const cleanup = () => {
				clearTimeout(timeout);
				socket.off("connect", onConnect);
				socket.off("error", onError);
			};
			const onConnect = () => {
				cleanup();
				resolve();
			};
			const onError = (error) => {
				cleanup();
				reject(error);
			};

			socket.once("connect", onConnect);
			socket.once("error", onError);
			socket.connect(port, host);
		});
	}

	async #handshake(socket) {
		const serverVersion = (await this.#readBytes(12)).toString("ascii").trim();
		socket.write(Buffer.from(RFB_VERSION, "ascii"));

		const numberOfTypes = (await this.#readBytes(1)).readUInt8(0);
		if (numberOfTypes === 0) {
			const reasonLength = (await this.#readBytes(4)).readUInt32BE(0);
			const reason = (await this.#readBytes(reasonLength)).toString("utf8");
			throw new Error(`Server refused connection: ${reason}`);
		}

		const securityTypes = Array.from(await this.#readBytes(numberOfTypes));
		if (!securityTypes.includes(1)) {
			if (securityTypes.includes(2)) {
				throw new Error("VNC password authentication is not supported. Use a no-auth VNC server.");
			}
			throw new Error(`Unsupported VNC security types: ${securityTypes.join(", ")}`);
		}

		socket.write(Buffer.from([1]));

		const securityResult = (await this.#readBytes(4)).readUInt32BE(0);
		if (securityResult !== 0) {
			const reasonLength = (await this.#readBytes(4)).readUInt32BE(0);
			const reason = reasonLength > 0 ? (await this.#readBytes(reasonLength)).toString("utf8") : "unknown error";
			throw new Error(`VNC authentication failed: ${reason}`);
		}

		socket.write(Buffer.from([1]));

		const serverInit = await this.#readBytes(24);
		const width = serverInit.readUInt16BE(0);
		const height = serverInit.readUInt16BE(2);
		const pixelFormat = this.#parsePixelFormat(serverInit.subarray(4, 20));
		const nameLength = serverInit.readUInt32BE(20);
		const desktopName = nameLength > 0 ? (await this.#readBytes(nameLength)).toString("utf8") : "";

		this.serverPixelFormat = pixelFormat;

		return {
			serverVersion,
			securityTypes,
			width,
			height,
			desktopName,
			pixelFormat,
		};
	}

	#readBytes(length) {
		if (length === 0) {
			return Promise.resolve(Buffer.alloc(0));
		}

		if (this.buffer.length >= length) {
			const chunk = this.buffer.subarray(0, length);
			this.buffer = this.buffer.subarray(length);
			return Promise.resolve(chunk);
		}

		return new Promise((resolve, reject) => {
			this.pendingReads.push({ length, resolve, reject });
		});
	}

	#onData(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		this.#flushReads();
	}

	#flushReads() {
		while (this.pendingReads.length > 0 && this.buffer.length >= this.pendingReads[0].length) {
			const pending = this.pendingReads.shift();
			const chunk = this.buffer.subarray(0, pending.length);
			this.buffer = this.buffer.subarray(pending.length);
			pending.resolve(chunk);
		}
	}

	#rejectPending(error) {
		while (this.pendingReads.length > 0) {
			this.pendingReads.shift().reject(error);
		}
	}

	#withTimeout(promise, timeoutMs, message) {
		let timeout = null;
		const timeoutPromise = new Promise((_, reject) => {
			timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
		});

		return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
	}

	#setState(partial) {
		this.state = {
			...this.state,
			...partial,
		};
		this.emit("state", this.getState());
	}

	#log(message, level = "info") {
		this.emit("log", {
			level,
			message,
			timestamp: new Date().toISOString(),
		});
	}
}
