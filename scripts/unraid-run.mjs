#!/usr/bin/env node
/**
 * Turns unraid/reel-exporter.xml into the `docker run -d` command that Unraid's
 * dockerMan generates (dynamix.docker.manager Helpers.php: xmlToCommand), and can
 * register the template and icon so the container shows up in the Docker tab like a
 * UI-created one (icon, Edit, WebUI link, autostart).
 *
 * Zero dependencies. Run as root on the Unraid host.
 *
 *   node scripts/unraid-run.mjs --dry-run
 *   node scripts/unraid-run.mjs --install-template --recreate
 *   node scripts/unraid-run.mjs --set /media=/mnt/user/media --set 7727=7727 --autostart
 *
 * Options
 *   --xml <file>        template (default: unraid/reel-exporter.xml)
 *   --image <ref>       override the image (e.g. a locally built tag)
 *   --set TARGET=VALUE  override a <Config> by its Target (container path, container port or variable name)
 *   --install-template  write /boot/config/plugins/dockerMan/templates-user/my-<Name>.xml with the
 *                       effective values, copy unraid/icon.png to /boot/config/plugins/dockerMan/images/
 *                       and point <Icon> at it via file:// (the GitHub URL only resolves once the repo is public)
 *   --icon <file>       icon PNG to install (default: unraid/icon.png)
 *   --autostart [secs]  add "<Name> [wait]" to /var/lib/docker/unraid-autostart (what the Docker tab toggle writes)
 *   --recreate          stop and remove an existing container with the same name first
 *   --pull              docker pull first (dockerMan only pulls when the image is absent)
 *   --dry-run           print the command and exit
 */
import {
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import { dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = {
  xml: resolve(here, "../unraid/reel-exporter.xml"),
  icon: resolve(here, "../unraid/icon.png"),
  set: [],
  image: null,
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--xml") opt.xml = resolve(argv[++i])
  else if (a === "--icon") opt.icon = resolve(argv[++i])
  else if (a === "--image") opt.image = argv[++i]
  else if (a === "--set") opt.set.push(argv[++i])
  else if (a === "--install-template") opt.install = true
  else if (a === "--autostart") {
    opt.autostart = true
    if (/^\d+$/.test(argv[i + 1] ?? "")) opt.wait = argv[++i]
  } else if (a === "--recreate") opt.recreate = true
  else if (a === "--pull") opt.pull = true
  else if (a === "--dry-run") opt.dry = true
  else {
    console.error(`unknown option: ${a}`)
    process.exit(2)
  }
}

// ---- minimal XML helpers (enough for our own template) ----
const decode = (s) =>
  String(s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
const encode = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
const xml = readFileSync(opt.xml, "utf8")
const tag = (name) => {
  const m = xml.match(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)
  )
  return m ? decode(m[1]).trim() : ""
}
const CONFIG_RE = /<Config\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Config>)/g
const configs = [...xml.matchAll(CONFIG_RE)].map((m) => {
  const attrs = Object.fromEntries(
    [...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, decode(v)])
  )
  const text = decode(m[2] ?? "").trim()
  return { ...attrs, Value: text || attrs.Default || "" }
})
for (const s of opt.set) {
  const eq = s.indexOf("=")
  const target = s.slice(0, eq)
  const value = s.slice(eq + 1)
  const c = configs.find((c) => c.Target === target)
  if (!c) {
    console.error(`--set: no <Config Target="${target}"> in template`)
    process.exit(2)
  }
  c.Value = value
}

// ---- what dockerMan reads from the host ----
const ini = (file) => {
  try {
    return Object.fromEntries(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => {
          const i = l.indexOf("=")
          return [
            l.slice(0, i).trim(),
            l
              .slice(i + 1)
              .trim()
              .replace(/^"(.*)"$/, "$1"),
          ]
        })
    )
  } catch {
    return {}
  }
}
const ident = ini("/boot/config/ident.cfg")
const dockerCfg = ini("/boot/config/docker.cfg")
const onUnraid = existsSync("/boot/config/plugins/dockerMan")
const TZ =
  ident.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
const HOST = ident.NAME || os.hostname()
const PIDS = dockerCfg.DOCKER_PID_LIMIT || "2048"

const name = tag("Name").replace(/\s+/g, "")
const repo = opt.image || tag("Repository")
const network = (tag("Network") || "bridge").toLowerCase()
const extra = tag("ExtraParams")
const postArgs = tag("PostArgs")
const IMAGES_DIR = "/boot/config/plugins/dockerMan/images"
const TEMPLATES_DIR = "/boot/config/plugins/dockerMan/templates-user"
const RAM_IMAGES =
  "/usr/local/emhttp/state/plugins/dynamix.docker.manager/images"
const iconDest = `${IMAGES_DIR}/${name}-icon.png`
const icon = opt.install ? `file://${iconDest}` : tag("Icon")

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const driverOf = (net) => {
  if (net.startsWith("container:")) return "container"
  const r = spawnSync(
    "docker",
    ["network", "inspect", "-f", "{{.Driver}}", net],
    { encoding: "utf8" }
  )
  return r.status === 0 ? r.stdout.trim() : "bridge"
}
const driver = driverOf(network)

// ---- compose exactly like xmlToCommand() ----
const env = [
  `TZ=${q(TZ)}`,
  `HOST_OS=${q("Unraid")}`,
  `HOST_HOSTNAME=${q(HOST)}`,
  `HOST_CONTAINERNAME=${q(name)}`,
]
const labels = ["net.unraid.docker.managed=dockerman"]
if (tag("WebUI")) labels.push(`net.unraid.docker.webui=${q(tag("WebUI"))}`)
if (icon) labels.push(`net.unraid.docker.icon=${q(icon)}`)
const ports = []
const vols = []
const devices = []
for (const c of configs) {
  const type = (c.Type || "").toLowerCase()
  if (type !== "device" && !c.Target) continue
  if (type === "path") {
    if (!c.Value.trim() || !c.Target.trim()) continue
    const mode = [
      "rw",
      "rw,slave",
      "rw,shared",
      "ro",
      "ro,slave",
      "ro,shared",
    ].includes((c.Mode || "").toLowerCase())
      ? c.Mode
      : "rw"
    vols.push(`${q(c.Value)}:${q(c.Target)}:${q(mode)}`)
    if (!opt.dry) ensureHostPath(c.Value, mode)
  } else if (type === "port") {
    const mode = ["tcp", "udp"].includes((c.Mode || "").toLowerCase())
      ? c.Mode.toLowerCase()
      : "tcp"
    if (["host", "macvlan", "ipvlan"].includes(driver))
      env.push(`${q(`${mode}_PORT_${c.Target}`).toUpperCase()}=${q(c.Value)}`)
    else if (driver === "bridge")
      ports.push(q(`${c.Value}:${c.Target}/${mode}`))
  } else if (type === "variable") env.push(`${q(c.Target)}=${q(c.Value)}`)
  else if (type === "label") labels.push(`${q(c.Target)}=${q(c.Value)}`)
  else if (type === "device") devices.push(q(c.Value))
}
const cmd = [
  "docker run -d",
  `--name=${q(name)}`,
  /--net(work)?[= ]/.test(extra) ? "" : `--net=${q(network)}`,
  tag("CPUset") ? `--cpuset-cpus=${q(tag("CPUset"))}` : "",
  /--pids-limit/.test(extra) ? "" : `--pids-limit ${PIDS}`,
  tag("Privileged").toLowerCase() === "true" ? "--privileged=true" : "",
  ...env.map((e) => `-e ${e}`),
  ...labels.map((l) => `-l ${l}`),
  ...ports.map((p) => `-p ${p}`),
  ...vols.map((v) => `-v ${v}`),
  ...devices.map((d) => `--device=${d}`),
  extra,
  q(repo),
  postArgs,
]
  .filter(Boolean)
  .join(" ")
  .replace(/\s\s+/g, " ")

function ensureHostPath(p, mode) {
  if (existsSync(p)) return
  if (mode.toLowerCase().startsWith("ro")) {
    console.error(`read-only host path does not exist: ${p}`)
    process.exit(1)
  }
  mkdirSync(p, { recursive: true, mode: 0o777 }) // dockerMan: mkdir 0777 + chown 99:100
  try {
    chownSync(p, 99, 100)
  } catch {
    /* not root or not Unraid */
  }
  console.log(`created ${p} (0777, 99:100)`)
}

function installTemplate() {
  if (!onUnraid) {
    console.error(
      "--install-template: /boot/config/plugins/dockerMan not found (not Unraid?)"
    )
    process.exit(1)
  }
  mkdirSync(IMAGES_DIR, { recursive: true })
  mkdirSync(TEMPLATES_DIR, { recursive: true })
  copyFileSync(opt.icon, iconDest)
  rmSync(`${RAM_IMAGES}/${name}-icon.png`, { force: true }) // drop the RAM copy so the Docker tab re-reads /boot
  let i = 0
  let out = xml.replace(
    CONFIG_RE,
    (_m, attrs) =>
      `<Config${attrs.replace(/\s*$/, "")}>${encode(configs[i++].Value)}</Config>`
  )
  out = out.replace(
    /<Icon(?:\s*\/>|>[\s\S]*?<\/Icon>)/,
    `<Icon>${encode(icon)}</Icon>`
  )
  if (opt.image)
    out = out.replace(
      /<Repository>[\s\S]*?<\/Repository>/,
      `<Repository>${encode(opt.image)}</Repository>`
    )
  if (!/<DateInstalled>/.test(out)) {
    out = out.replace(
      /\n<\/Container>/,
      `\n  <DateInstalled>${Math.floor(Date.now() / 1000)}</DateInstalled>\n</Container>`
    )
  }
  const dest = `${TEMPLATES_DIR}/my-${name}.xml`
  writeFileSync(dest, out)
  console.log(`installed ${dest} and ${iconDest}`)
}

function enableAutostart() {
  const f = "/var/lib/docker/unraid-autostart"
  const lines = existsSync(f)
    ? readFileSync(f, "utf8").split("\n").filter(Boolean)
    : []
  if (lines.some((l) => l.split(" ")[0] === name)) {
    console.log("autostart already on")
    return
  }
  lines.push(opt.wait ? `${name} ${opt.wait}` : name)
  writeFileSync(f, lines.join("\n") + "\n")
  console.log(`autostart on (${f})`)
}

const sh = (c) => {
  console.log(`\n$ ${c}`)
  return spawnSync("/bin/sh", ["-c", c], { stdio: "inherit" }).status ?? 1
}

console.log(cmd.replace(/ -/g, "\n  -"))
if (opt.dry) process.exit(0)
if (process.getuid?.() !== 0) {
  console.error("run as root")
  process.exit(1)
}
if (opt.install) installTemplate()
if (opt.pull) sh(`docker pull ${q(repo)}`)
if (opt.recreate)
  sh(
    `docker stop -t 10 ${q(name)} >/dev/null 2>&1; docker rm ${q(name)} >/dev/null 2>&1; true`
  )
const rc = sh(cmd)
if (rc !== 0) process.exit(rc)
if (opt.autostart) enableAutostart()
console.log(`\n${name} started. Docker tab: http://${HOST}/Docker`)
