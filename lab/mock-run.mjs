// The mock M-Pesa in its own process, so the off-ramp can crash and restart without it.
import { mockDaraja } from "../src/mock-daraja.mjs";
const L = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
let mode = process.env.MODE || "ok";
const m = mockDaraja({ port: 7070, key: "lab-key", secret: "lab-secret", initiator: "labapi", password: "Lab#2026",
  privateKeyPath: `${L}/keys/mock-daraja.key`, utility: Number(process.env.FLOAT || 20000), mode: () => mode });
process.on("SIGUSR1", () => { mode = mode === "silent" ? "ok" : "silent"; });
console.log(`mock M-Pesa on :7070 mode=${mode}`);
