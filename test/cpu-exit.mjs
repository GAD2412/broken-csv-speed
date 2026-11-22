// Preloaded with --import: prints this process's CPU time (user + system, every thread, microseconds) at exit.
process.on('exit', () => {
  const u = process.cpuUsage();
  process.stderr.write(`CPU_US ${u.user + u.system}\n`);
});
