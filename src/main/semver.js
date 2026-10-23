// Version comparison: "1.10.0" > "1.9.3", and an official "1.2.0" > a beta build "1.2.0-dev".
function isNewer(latest, current) {
  const parse = (v) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(v || '') || [0, 0, 0, 0]).slice(1).map(Number);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return String(current).includes('-') && !String(latest).includes('-');
}

module.exports = { isNewer };
