// tests/setup.js
import crypto from 'crypto';

// JSDOM can expose browser-like globals differently depending on environment.
// Ensure `self` exists before defining `self.crypto` so test bootstrap is robust.
if (!global.self) {
  global.self = global;
}

Object.defineProperty(global.self, 'crypto', {
  value: {
    randomUUID: crypto.randomUUID
  }
});
