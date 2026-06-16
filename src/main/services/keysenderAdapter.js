import { createRequire } from "module";

function makeNoopKeyboard() {
  const noop = () => {};
  return {
    sendKeys: noop,
    sendKey: noop,
    toggleKey: noop,
    printText: noop,
  };
}

/**
 * Synchronously return a Hardware-like object. If `keysender` is available
 * it will return `new Hardware(name)`. If not, it returns a fallback with a
 * no-op `keyboard` to allow the app to run without native build tools.
 */
export function getHardware(name) {
  try {
    const require = createRequire(import.meta.url);
    // Use require to synchronously load the CommonJS module.
    const ks = require("keysender");
    const Hardware = ks && (ks.Hardware || ks.default?.Hardware || ks.default || ks);
    if (typeof Hardware === "function") {
      return new Hardware(name);
    }
    return { keyboard: makeNoopKeyboard() };
  } catch (err) {
    return { keyboard: makeNoopKeyboard() };
  }
}

export default getHardware;
