import { jest } from "@jest/globals";
import { createRfbKeyEvent, keyToKeysym, normalizeVncTcpConfig, VncTcpService } from "../src/main/services/vncTcpService.js";

function createConnectedService() {
	const configService = {
		value: {
			vncTcp: {
				host: "127.0.0.1",
				port: 5901,
				enabled: true,
				tapDelayMs: 12,
			},
		},
		updateVncTcp: jest.fn(),
	};
	const service = new VncTcpService(configService);
	const socket = {
		destroyed: false,
		write: jest.fn(() => true),
	};

	service.socket = socket;
	service.state = {
		...service.state,
		status: "connected",
	};

	return { service, socket };
}

describe("VncTcpService helpers", () => {
	it("maps printable keys and common special keys to X11 keysyms", () => {
		expect(keyToKeysym("y")).toBe(0x79);
		expect(keyToKeysym(";")).toBe(0x3b);
		expect(keyToKeysym("Enter")).toBe(0xff0d);
		expect(keyToKeysym("ArrowUp")).toBe(0xff52);
		expect(keyToKeysym("F12")).toBe(0xffc9);
		expect(keyToKeysym("not-a-key")).toBeNull();
	});

	it("creates an 8-byte RFB KeyEvent message", () => {
		expect(createRfbKeyEvent(0x79, true)).toEqual(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x79]));
		expect(createRfbKeyEvent(0x79, false)).toEqual(Buffer.from([4, 0, 0, 0, 0, 0, 0, 0x79]));
	});

	it("normalizes host, port, and enabled values", () => {
		expect(normalizeVncTcpConfig({ host: " 10.0.0.5 ", port: "5902", enabled: true })).toEqual({
			host: "10.0.0.5",
			port: 5902,
			enabled: true,
			tapDelayMs: 12,
		});
		expect(normalizeVncTcpConfig({ host: "", port: "bad", enabled: "yes" })).toEqual({
			host: "192.168.1.6",
			port: 5901,
			enabled: false,
			tapDelayMs: 12,
		});
		expect(normalizeVncTcpConfig({ tapDelayMs: "300" }).tapDelayMs).toBe(100);
		expect(normalizeVncTcpConfig({ tapDelayMs: "0" }).tapDelayMs).toBe(1);
	});
});

describe("VncTcpService key output", () => {
	it("sends every explicit key event without suppressing repeated same-key events", () => {
		const { service, socket } = createConnectedService();
		const log = jest.fn();
		service.on("log", log);

		expect(service.sendKey("y", true)).toBe(true);
		expect(service.sendKey("y", true)).toBe(true);
		expect(service.sendKey("y", false)).toBe(true);
		expect(service.sendKey("y", false)).toBe(true);

		expect(socket.write).toHaveBeenCalledTimes(4);
		expect(socket.write).toHaveBeenNthCalledWith(1, createRfbKeyEvent(0x79, true));
		expect(socket.write).toHaveBeenNthCalledWith(2, createRfbKeyEvent(0x79, true));
		expect(socket.write).toHaveBeenNthCalledWith(3, createRfbKeyEvent(0x79, false));
		expect(socket.write).toHaveBeenNthCalledWith(4, createRfbKeyEvent(0x79, false));
		expect(log).not.toHaveBeenCalled();
	});

	it("adds the configured delay between tap down and up packets", () => {
		jest.useFakeTimers();

		try {
			const { service, socket } = createConnectedService();

			expect(service.tapKey("y", 25)).toBe(true);
			expect(socket.write).toHaveBeenCalledTimes(1);
			expect(socket.write).toHaveBeenNthCalledWith(1, createRfbKeyEvent(0x79, true));

			jest.advanceTimersByTime(24);
			expect(socket.write).toHaveBeenCalledTimes(1);

			jest.advanceTimersByTime(1);
			expect(socket.write).toHaveBeenCalledTimes(2);
			expect(socket.write).toHaveBeenNthCalledWith(2, createRfbKeyEvent(0x79, false));
		} finally {
			jest.useRealTimers();
		}
	});

	it("queues repeated same-key taps so every song click still plays", () => {
		jest.useFakeTimers();

		try {
			const { service, socket } = createConnectedService();

			expect(service.tapKey("y", 25)).toBe(true);
			expect(service.tapKey("y", 25)).toBe(true);
			expect(socket.write).toHaveBeenCalledTimes(1);
			expect(socket.write).toHaveBeenNthCalledWith(1, createRfbKeyEvent(0x79, true));

			jest.advanceTimersByTime(25);
			expect(socket.write).toHaveBeenCalledTimes(3);
			expect(socket.write).toHaveBeenNthCalledWith(2, createRfbKeyEvent(0x79, false));
			expect(socket.write).toHaveBeenNthCalledWith(3, createRfbKeyEvent(0x79, true));

			jest.advanceTimersByTime(25);
			expect(socket.write).toHaveBeenCalledTimes(4);
			expect(socket.write).toHaveBeenNthCalledWith(4, createRfbKeyEvent(0x79, false));
		} finally {
			jest.useRealTimers();
		}
	});
});
