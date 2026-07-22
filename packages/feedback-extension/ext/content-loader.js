// Classic isolated-world loader: manifest-declared content scripts cannot be
// modules, but dynamic import of a web-accessible extension URL can.
import(chrome.runtime.getURL("content/main.mjs")).catch((error) => {
  console.warn("sassfully-ext: content module failed to load", error);
});
