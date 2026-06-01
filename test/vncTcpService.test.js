import { createRfbKeyEvent, keyToKeysym, normalizeVncTcpConfig } from "../src/main/services/vncTcpService.js";

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
		});
		expect(normalizeVncTcpConfig({ host: "", port: "bad", enabled: "yes" })).toEqual({
			host: "192.168.1.6",
			port: 5901,
			enabled: false,
		});
	});
});
