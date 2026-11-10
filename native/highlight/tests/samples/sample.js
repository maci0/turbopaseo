/** @param {number} n */
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
const re = /a+b*/gi, s = 'single', t = `tpl ${fib(10)}`;
let obj = { key: true, other: null, [s]: undefined };
for (const k in obj) console.log(k, obj[k]);
