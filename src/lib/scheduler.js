// Runs the background jobs (episode alerts, server feeds) on fixed intervals.
//
// A tick that is still running when the next one is due is not doubled up: the
// next one is simply skipped. Every job is cursor-driven, so a skipped tick is
// caught up by the following one rather than lost.

const jobs = [];
let started = false;

function register(name, intervalMs, run) {
  jobs.push({ name, intervalMs, run, timer: null, running: false });
}

async function tick(job) {
  if (job.running) return;
  job.running = true;
  try {
    await job.run();
  } catch (error) {
    console.error(`Job "${job.name}" failed:`, error);
  } finally {
    job.running = false;
  }
}

function start() {
  if (started) return;
  started = true;
  for (const job of jobs) {
    job.timer = setInterval(() => tick(job), job.intervalMs);
    // The first run happens straight away rather than one interval in, so a
    // restart does not leave a gap.
    tick(job);
  }
}

function stop() {
  for (const job of jobs) clearInterval(job.timer);
  started = false;
}

module.exports = { register, start, stop };
