#!/usr/bin/env python3
"""
vnc_keyboard_mirror.py
======================
Listens to every keystroke on THIS machine and forwards it as an
RFB KeyEvent to a VNC server over a raw TCP connection.

Requirements:
    pip install pynput

Usage:
    python3 vnc_keyboard_mirror.py            # uses defaults below
    python3 vnc_keyboard_mirror.py 10.0.0.5 5902

Press Ctrl+C to stop.
"""

import socket
import struct
import sys
import threading
import time

# ── Configuration ────────────────────────────────────────────────────────────
VNC_HOST = "192.168.1.6"
VNC_PORT = 5901
# ─────────────────────────────────────────────────────────────────────────────

# Override host/port from command-line args if given
if len(sys.argv) >= 2:
    VNC_HOST = sys.argv[1]
if len(sys.argv) >= 3:
    VNC_PORT = int(sys.argv[2])


# ── X11 Keysym table for pynput special Key.* values ─────────────────────────
# Full list: https://www.cl.cam.ac.uk/~mgk25/ucs/keysymdef.h
from pynput.keyboard import Key, KeyCode, Listener

SPECIAL_KEYSYM = {
    # Modifiers
    Key.shift:        0xFFE1,  # Left Shift
    Key.shift_r:      0xFFE2,  # Right Shift
    Key.ctrl:         0xFFE3,  # Left Ctrl
    Key.ctrl_r:       0xFFE4,  # Right Ctrl
    Key.alt:          0xFFE9,  # Left Alt
    Key.alt_r:        0xFFEA,  # Right Alt (AltGr)
    Key.cmd:          0xFFEB,  # Left Super/Win
    Key.cmd_r:        0xFFEC,  # Right Super/Win

    # Navigation
    Key.up:           0xFF52,
    Key.down:         0xFF54,
    Key.left:         0xFF51,
    Key.right:        0xFF53,
    Key.home:         0xFF50,
    Key.end:          0xFF57,
    Key.page_up:      0xFF55,
    Key.page_down:    0xFF56,

    # Editing
    Key.enter:        0xFF0D,
    Key.backspace:    0xFF08,
    Key.delete:       0xFFFF,
    Key.insert:       0xFF63,
    Key.tab:          0xFF09,
    Key.space:        0x0020,
    Key.esc:          0xFF1B,
    Key.caps_lock:    0xFFE5,
    Key.num_lock:     0xFF7F,
    Key.scroll_lock:  0xFF14,
    Key.pause:        0xFF13,
    Key.print_screen: 0xFF61,
    Key.menu:         0xFF67,

    # Function keys
    Key.f1:  0xFFBE, Key.f2:  0xFFBF, Key.f3:  0xFFC0,
    Key.f4:  0xFFC1, Key.f5:  0xFFC2, Key.f6:  0xFFC3,
    Key.f7:  0xFFC4, Key.f8:  0xFFC5, Key.f9:  0xFFC6,
    Key.f10: 0xFFC7, Key.f11: 0xFFC8, Key.f12: 0xFFC9,
    Key.f13: 0xFFCA, Key.f14: 0xFFCB, Key.f15: 0xFFCC,
    Key.f16: 0xFFCD, Key.f17: 0xFFCE, Key.f18: 0xFFCF,
    Key.f19: 0xFFD0, Key.f20: 0xFFD1,

    # Numpad (pynput exposes them as KeyCode with vk on some platforms)
    # Key.kp_* may not exist on all platforms; guard with getattr
}

# Add numpad keys that exist on this pynput version
for _name, _sym in [
    ("kp0", 0xFFB0), ("kp1", 0xFFB1), ("kp2", 0xFFB2), ("kp3", 0xFFB3),
    ("kp4", 0xFFB4), ("kp5", 0xFFB5), ("kp6", 0xFFB6), ("kp7", 0xFFB7),
    ("kp8", 0xFFB8), ("kp9", 0xFFB9), ("kp_add", 0xFFAB),
    ("kp_subtract", 0xFFAD), ("kp_multiply", 0xFFAA), ("kp_divide", 0xFFAF),
    ("kp_decimal", 0xFFAE), ("kp_enter", 0xFF8D),
]:
    _k = getattr(Key, _name, None)
    if _k is not None:
        SPECIAL_KEYSYM[_k] = _sym


def key_to_keysym(key):
    """
    Convert a pynput key object to an X11 keysym integer.
    Returns None if the key cannot be mapped.
    """
    # Special keys (Key.enter, Key.shift, …)
    if isinstance(key, Key):
        return SPECIAL_KEYSYM.get(key)

    # Regular characters / KeyCode
    if isinstance(key, KeyCode):
        if key.char is not None:
            ch = key.char
            # ASCII printable range maps 1:1 to X11 keysym
            cp = ord(ch)
            if 0x0020 <= cp <= 0x007E:
                return cp
            # Latin-1 supplement (accented chars, etc.)
            if 0x00A0 <= cp <= 0x00FF:
                return cp
            # Unicode BMP: X11 encodes as 0x01000000 | codepoint
            if cp > 0x00FF:
                return 0x01000000 | cp
        # vk fallback (Windows virtual-key codes) - best-effort
        if key.vk is not None:
            vk = key.vk
            # VK 0x30-0x39 = digits 0-9
            if 0x30 <= vk <= 0x39:
                return vk
            # VK 0x41-0x5A = A-Z → map to lowercase keysym
            if 0x41 <= vk <= 0x5A:
                return vk + 0x20
    return None


# ── RFB helpers ───────────────────────────────────────────────────────────────

def rfb_key_event(sock, keysym: int, down: bool):
    """Send one RFB KeyEvent message (8 bytes)."""
    msg = struct.pack("!BBH I", 4, int(down), 0, keysym)
    try:
        sock.sendall(msg)
    except OSError:
        pass  # connection dropped; main thread will handle


def rfb_handshake(sock):
    """Minimal RFB 3.8 handshake (security type None or VNC-auth prompt)."""
    # ProtocolVersion
    server_ver = sock.recv(12)
    print(f"  Server: {server_ver.decode().strip()}")
    sock.sendall(b"RFB 003.008\n")

    # Security types
    n = struct.unpack("!B", sock.recv(1))[0]
    if n == 0:
        rlen = struct.unpack("!I", sock.recv(4))[0]
        raise ConnectionError("Server refused: " + sock.recv(rlen).decode())
    types = list(sock.recv(n))
    print(f"  Security types: {types}")

    if 1 in types:          # None (no password)
        sock.sendall(b"\x01")
    elif 2 in types:        # VNC Authentication
        sock.sendall(b"\x02")
        # Read 16-byte challenge (we cannot decrypt without password here)
        challenge = sock.recv(16)
        raise NotImplementedError(
            "VNC password authentication required.\n"
            "Run the VNC server with no-auth / no-password mode, "
            "or use a library like 'vncdotool' for password support."
        )
    else:
        sock.sendall(bytes([types[0]]))

    # Security result
    result = struct.unpack("!I", sock.recv(4))[0]
    if result != 0:
        rlen = struct.unpack("!I", sock.recv(4))[0]
        raise ConnectionError("Auth failed: " + sock.recv(rlen).decode())

    # ClientInit (shared=1)
    sock.sendall(b"\x01")

    # ServerInit
    w, h = struct.unpack("!HH", sock.recv(4))
    sock.recv(16)                                   # pixel format
    nlen = struct.unpack("!I", sock.recv(4))[0]
    name = sock.recv(nlen).decode(errors="replace")
    print(f"  Desktop: '{name}'  {w}×{h}")


# ── Global VNC socket (shared between listener callbacks and main) ─────────────
_vnc_sock = None
_stop_event = threading.Event()


# ── pynput callbacks ──────────────────────────────────────────────────────────

def on_press(key):
    if _stop_event.is_set():
        return False  # stop listener

    keysym = key_to_keysym(key)
    if keysym is None:
        print(f"  [?] unmapped key: {key!r}")
        return

    label = getattr(key, "char", None) or key
    print(f"  ↓ {label!r:20s}  keysym=0x{keysym:04X}")
    rfb_key_event(_vnc_sock, keysym, down=True)


def on_release(key):
    if _stop_event.is_set():
        return False

    keysym = key_to_keysym(key)
    if keysym is None:
        return

    rfb_key_event(_vnc_sock, keysym, down=False)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    global _vnc_sock

    print(f"\n{'─'*55}")
    print(f"  VNC Keyboard Mirror")
    print(f"  Target : {VNC_HOST}:{VNC_PORT}")
    print(f"  Stop   : Ctrl+C")
    print(f"{'─'*55}\n")

    print("Connecting …")
    try:
        _vnc_sock = socket.create_connection((VNC_HOST, VNC_PORT), timeout=10)
        _vnc_sock.settimeout(None)          # blocking after handshake
    except OSError as e:
        sys.exit(f"Cannot connect to {VNC_HOST}:{VNC_PORT} — {e}")

    try:
        rfb_handshake(_vnc_sock)
    except (ConnectionError, NotImplementedError, OSError) as e:
        _vnc_sock.close()
        sys.exit(str(e))

    print("\nListening for keystrokes … (Ctrl+C to quit)\n")

    listener = Listener(on_press=on_press, on_release=on_release)
    listener.start()

    try:
        while listener.is_alive():
            time.sleep(0.1)
    except KeyboardInterrupt:
        print("\n\nCtrl+C received — stopping.")
    finally:
        _stop_event.set()
        listener.stop()
        try:
            _vnc_sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        _vnc_sock.close()
        print("Disconnected. Bye!")


if __name__ == "__main__":
    main()