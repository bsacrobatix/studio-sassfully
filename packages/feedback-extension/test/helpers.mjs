// A single fake window shared by "both worlds": message events post back to
// the same window asynchronously, mirroring how MAIN-world and isolated
// content scripts, plus the host page, all hear the page window's messages.
export function fakeWindow(origin = "https://app.example") {
  const listeners = new Set();
  const win = {
    location: { origin, href: `${origin}/checkout?step=2` },
    addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
    removeEventListener(type, listener) { listeners.delete(listener); },
    postMessage(data) {
      queueMicrotask(() => {
        const event = { data: structuredClone(data), origin, source: win };
        for (const listener of [...listeners]) listener(event);
      });
    },
    console: { error() {}, warn() {} },
  };
  return win;
}

export const settle = () => new Promise((resolve) => setImmediate(resolve));

/** rrweb-ish event stream helpers. */
export const meta = (timestamp) => ({ type: 4, data: { href: "https://app.example/", width: 1280, height: 720 }, timestamp });
export const fullSnapshot = (timestamp, fill = "") => ({ type: 2, data: { node: { id: 1, fill } }, timestamp });
export const incremental = (timestamp, fill = "") => ({ type: 3, data: { source: 1, fill }, timestamp });
