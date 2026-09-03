import { describe, expect, it } from "vitest"
import {
  detectMounts,
  isUnder,
  mountFor,
  parseMountInfo,
  selectCandidates,
} from "../library/mounts.js"

const FIXTURE = `
5094 4638 0:50 /btrfs/subvolumes/75ce7 / rw,noatime - btrfs /dev/loop2 rw,ssd,discard=async
5096 5094 0:938 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
5099 5094 0:958 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro
5097 5094 0:939 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
5098 5097 0:960 / /dev/pts rw,nosuid,noexec,relatime - devpts devpts rw,gid=5,mode=620
5100 5097 0:961 / /dev/mqueue rw,nosuid,nodev,noexec,relatime - mqueue mqueue rw
5101 5099 0:30 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw
5107 5094 0:49 /appdata/reel-vault/hosts /etc/hosts rw,nosuid,nodev,noatime - fuse.shfs shfs rw,user_id=0
5108 5094 0:49 /appdata/reel-vault/resolv.conf /etc/resolv.conf rw,nosuid,nodev,noatime - fuse.shfs shfs rw
5104 5094 0:49 /appdata/reel-vault /config rw,nosuid,nodev,noatime - fuse.shfs shfs rw,user_id=0,group_id=0
5103 5094 0:49 /data/reel-vault /output rw,nosuid,nodev,noatime - fuse.shfs shfs rw,user_id=0
5109 5094 0:49 /other/projects/reel-vault /app rw,nosuid,nodev,noatime - fuse.shfs shfs rw
5105 5094 0:49 /data/media /media ro,nosuid,nodev,noatime - fuse.shfs shfs rw,user_id=0,group_id=0
5106 5105 0:49 /data/media/movies /media/movies ro,nosuid,nodev,noatime - fuse.shfs shfs rw,user_id=0
5110 5094 0:49 /other/videos /media2 ro,nosuid,nodev,noatime - fuse.shfs shfs rw
5111 5094 8:1 /video\\040two /media\\040two ro,relatime - ext4 /dev/sda1 rw
`

describe("parseMountInfo", () => {
  it("maps the fields and reads ro from the per-mount options", () => {
    const entries = parseMountInfo(FIXTURE)
    const media = entries.find((e) => e.mountPoint === "/media")!
    expect(media.id).toBe(5105)
    expect(media.parentId).toBe(5094)
    expect(media.root).toBe("/data/media")
    expect(media.fsType).toBe("fuse.shfs")
    expect(media.source).toBe("shfs")
    expect(media.readOnly).toBe(true)
    expect(media.superOptions).toContain("rw")
    const cfg = entries.find((e) => e.mountPoint === "/config")!
    expect(cfg.readOnly).toBe(false)
    expect(entries.find((e) => e.mountPoint === "/media two")?.root).toBe(
      "/video two"
    )
  })

  it("ignores malformed lines and empty input", () => {
    expect(parseMountInfo("")).toEqual([])
    expect(parseMountInfo("garbage line without separator\n1 2")).toEqual([])
  })
})

describe("selectCandidates", () => {
  it("keeps media-like mounts and collapses nested submounts", () => {
    const entries = parseMountInfo(FIXTURE)
    const out = selectCandidates(entries, {
      exclude: ["/config", "/output", "/app"],
    })
    expect(out.map((c) => c.path)).toEqual(["/media", "/media two", "/media2"])
    expect(out[0]).toMatchObject({
      path: "/media",
      hostPath: "/mnt/user/data/media",
      readOnly: true,
      fsType: "fuse.shfs",
    })
    expect(out[2]).toMatchObject({
      path: "/media2",
      hostPath: "/mnt/user/other/videos",
    })
    expect(out[1]?.hostPath).toBe("/video two")
  })

  it("keeps a nested mount when its parent is not mounted", () => {
    const entries = parseMountInfo(FIXTURE).filter(
      (e) => e.mountPoint !== "/media"
    )
    const out = selectCandidates(entries, { exclude: [] })
    expect(out.map((c) => c.path)).toContain("/media/movies")
  })
})

describe("helpers", () => {
  it("isUnder", () => {
    expect(isUnder("/media/movies", "/media")).toBe(true)
    expect(isUnder("/media2", "/media")).toBe(false)
    expect(isUnder("/media", "/media")).toBe(true)
    expect(isUnder("/anything", "/")).toBe(true)
  })

  it("mountFor picks the closest mount", () => {
    const candidates = selectCandidates(parseMountInfo(FIXTURE), {
      exclude: [],
    })
    expect(mountFor(candidates, "/media/tv")?.path).toBe("/media")
    expect(mountFor(candidates, "/media2")?.path).toBe("/media2")
    expect(mountFor(candidates, "/elsewhere")).toBeNull()
  })

  it("detectMounts returns [] for an unreadable file", async () => {
    expect(await detectMounts({ file: "/nonexistent/mountinfo" })).toEqual([])
  })
})
