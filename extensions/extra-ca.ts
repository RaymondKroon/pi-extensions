/**
 * extra-ca.ts — trust private root CAs inside pi, keyed by PEM file name.
 *
 * pi has no setting for custom CAs. Its HTTP stack (undici) performs all TLS
 * through the singleton `node:tls` module, so we patch `tls.connect` /
 * `tls.TLSSocket` to append the matching root CA per host.
 * This works regardless of pi's fetch/dispatcher re-installation and needs
 * no npm dependencies.
 *
 * Convention: every *.pem file in ~/.pi/agent/certs/ is named after the
 * hostname it should be trusted for, e.g.:
 *   k8s.ailabs.private.kadaster.nl.pem  -> trusted for that host + subdomains
 *
 * The directory can be overridden with PI_EXTRA_CERTS_DIR=/path/to/certs.
 * Files that are not valid PEM certificates are skipped with a warning.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CERTS_DIR =
  process.env.PI_EXTRA_CERTS_DIR ?? path.join(os.homedir(), ".pi", "agent", "certs");

interface HostCa {
  host: string;
  pem: Buffer;
}

function loadHostCas(dir: string): HostCa[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const cas: HostCa[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".pem")) continue;
    const host = entry.slice(0, -4); // strip .pem
    if (host.length === 0 || host.includes("/") || host.includes("..")) continue;
    const file = path.join(dir, entry);
    try {
      const pem = fs.readFileSync(file);
      if (!pem.includes("BEGIN CERTIFICATE")) {
        console.error(`[extra-ca] skipping ${file}: no PEM certificate found`);
        continue;
      }
      cas.push({ host, pem });
    } catch (err) {
      console.error(`[extra-ca] skipping ${file}: ${(err as Error).message}`);
    }
  }
  return cas;
}

let HOST_CAS: HostCa[] = [];

function casForHost(value: unknown): Buffer[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return HOST_CAS.filter((c) => value === c.host || value.endsWith(`.${c.host}`)).map((c) => c.pem);
}

function withCa(options: any): any {
  if (!options || typeof options !== "object" || options.isServer) return options;
  const extra = casForHost(options.servername ?? options.host);
  if (extra.length === 0) return options;
  const existing = options.ca
    ? Array.isArray(options.ca)
      ? options.ca
      : [options.ca]
    : [];
  return { ...options, ca: [...existing, ...extra] };
}

export default function (pi: ExtensionAPI) {
  HOST_CAS = loadHostCas(CERTS_DIR);

  if (HOST_CAS.length === 0) {
    console.error(
      `[extra-ca] no *.pem files found in ${CERTS_DIR} — no extra CAs loaded. ` +
        "Name each PEM after the hostname it should be trusted for.",
    );
    return;
  }

  // Patch tls.connect (used by undici's connector and node:https).
  const origConnect = tls.connect.bind(tls);
  (tls as any).connect = function patchedConnect(this: unknown, ...args: any[]) {
    if (args.length > 0 && typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0])) {
      args[0] = withCa(args[0]);
    }
    return (origConnect as any).apply(this, args);
  };

  // Patch TLSSocket for code paths that construct sockets directly.
  const OrigTLSSocket = tls.TLSSocket;
  class PatchedTLSSocket extends OrigTLSSocket {
    constructor(socket: any, options: any) {
      super(socket, withCa(options));
    }
  }
  (tls as any).TLSSocket = PatchedTLSSocket;

  pi.on("session_start", async (_event, ctx) => {
    const summary = HOST_CAS.map((c) => c.host).join(", ");
    ctx.ui.notify?.(`extra-ca: ${HOST_CAS.length} CA(s) from ${CERTS_DIR} — ${summary}`, "info");
  });
}
