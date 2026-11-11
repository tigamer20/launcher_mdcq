// Pause and cancel for the installation (INSTALLER, and the updates JOUER applies).
// Downloads wait at checkpoints while paused; cancelling stops the downloads and the NeoForge installer.
// Files already downloaded are kept, so the next INSTALLER continues where it stopped.

class CancelledError extends Error {
  constructor() {
    super('Installation annulée.');
    this.cancelled = true;
  }
}

let active = false;
let paused = false;
let cancelled = false;
let aborter = new AbortController();
let waiters = [];
const children = new Set();
const listeners = new Set();

const notify = () => listeners.forEach((fn) => fn({ active, paused, cancelled }));
const wakeUp = () => {
  waiters.forEach((resolve) => resolve());
  waiters = [];
};

/** A new installation starts: not paused, not cancelled. */
function begin() {
  active = true;
  paused = false;
  cancelled = false;
  aborter = new AbortController();
  notify();
}

function end() {
  active = false;
  paused = false;
  wakeUp();
  notify();
}

function pause() {
  if (!active || cancelled) return;
  paused = true;
  notify();
}

function resume() {
  paused = false;
  wakeUp();
  notify();
}

function cancel() {
  if (!active) return;
  cancelled = true;
  paused = false;
  aborter.abort(new CancelledError());
  for (const child of children) child.kill();
  wakeUp();
  notify();
}

/** Waits while paused; throws when the installation was cancelled. */
async function checkpoint() {
  while (paused && !cancelled) await new Promise((resolve) => waiters.push(resolve));
  if (cancelled) throw new CancelledError();
}

/** Signal for fetch(): aborts the download when the installation is cancelled. */
const signal = () => aborter.signal;

/** A program (NeoForge installer) that must be stopped if the installation is cancelled. */
function track(child) {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

const isCancelled = () => cancelled;
const onChange = (fn) => listeners.add(fn);

module.exports = { CancelledError, begin, end, pause, resume, cancel, checkpoint, signal, track, isCancelled, onChange };
