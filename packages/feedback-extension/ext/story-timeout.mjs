export function withTimeout(operation, { ms, stage, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimer(() => reject(new Error(`${stage} timed out after ${Math.ceil(ms / 1000)} seconds`)), ms);
    Promise.resolve(operation).then(
      (value) => { clearTimer(timer); resolve(value); },
      (error) => { clearTimer(timer); reject(error); },
    );
  });
}
