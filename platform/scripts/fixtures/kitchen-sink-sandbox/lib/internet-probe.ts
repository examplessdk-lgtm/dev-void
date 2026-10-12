// Probe the connection without DNS and explicitly close it on timeout. Both
// Internet-disabled and Internet-enabled cases run this same command.
export const internetAccessProbe = [
  'node',
  '-e',
  `const request = require("node:https").get(process.argv[1], response => {
    clearTimeout(timer);
    response.destroy();
    process.exitCode = 1;
  });
  const timer = setTimeout(() => request.destroy(new Error("Internet probe timed out")), Number(process.argv[2]));
  request.on("error", () => {
    clearTimeout(timer);
    process.exitCode = 0;
  });`,
  'https://1.1.1.1/cdn-cgi/trace',
  '3000',
];
