import { describe, expect, it } from "vitest"
import {
  cleanEpisodeTitle,
  cleanTitle,
  displayLibraryName,
  episodeLabel,
  formatTimestampForName,
  isVideoFile,
  parseEpisode,
  parseSeasonDir,
  safeName,
  sortKey,
  nextCaptureNumber,
  parseCaptureNumber,
} from "../library/naming.js"

describe("parseSeasonDir", () => {
  it.each([
    ["Season 01", 1, undefined],
    ["Season 1", 1, undefined],
    ["season 1", 1, undefined],
    ["Season01", 1, undefined],
    ["Specials", 0, undefined],
    ["Season 00", 0, undefined],
    ["Season 21 - Wano Country", 21, "Wano Country"],
    ["SpongeBob SquarePants - Season 3", 3, undefined],
  ])("%s -> %s", (name, number, title) => {
    const m = parseSeasonDir(name)
    expect(m?.number).toBe(number)
    expect(m?.title).toBe(title)
  })

  it.each([
    "screenshots",
    "Featurettes",
    "Series 7 (2001)",
    "Season 2 (2020)",
    "S1m0ne (2002)",
    "Extras",
  ])("%s is not a season", (name) => expect(parseSeasonDir(name)).toBeNull())
})

describe("parseEpisode", () => {
  it("parses Sonarr names", () => {
    const m = parseEpisode(
      "Reacher (2022) - S01E01 - Welcome to Margrave [AMZN WEBRip-1080p][EAC3 5.1][x264]-NTb",
      { allowBare: false }
    )
    expect(m).toMatchObject({ season: 1, episode: 1, explicit: true })
    expect(cleanEpisodeTitle(m!.rest)).toBe("Welcome to Margrave")
  })
  it("parses double episodes", () => {
    expect(
      parseEpisode("Show - S01E01-E02 - Pilot", { allowBare: false })
    ).toMatchObject({
      season: 1,
      episode: 1,
      episodeEnd: 2,
    })
  })
  it("parses NNxNNN", () => {
    const m = parseEpisode("One Piece - 21x1088 - Luffy's Dream", {
      allowBare: false,
    })
    expect(m).toMatchObject({ season: 21, episode: 1088, explicit: true })
    expect(cleanEpisodeTitle(m!.rest)).toBe("Luffy's Dream")
  })
  it("parses dotted scene names", () => {
    const m = parseEpisode(
      "Share.Al.Asha.S01E04.1080p.SHAHID.WEB-DL.AAC2.0.H.264-POWER",
      { allowBare: false }
    )
    expect(m).toMatchObject({ season: 1, episode: 4 })
    expect(cleanEpisodeTitle(m!.rest)).toBeUndefined()
  })
  it("parses Ep14 and bare numbers", () => {
    expect(parseEpisode("Ep14", { allowBare: false })).toMatchObject({
      episode: 14,
      explicit: false,
    })
    expect(parseEpisode("03", { allowBare: true })).toMatchObject({
      episode: 3,
      explicit: false,
    })
    expect(parseEpisode("03 - The Title", { allowBare: true })).toMatchObject({
      episode: 3,
      rest: "The Title",
    })
    expect(parseEpisode("03", { allowBare: false })).toBeNull()
  })
  it("does not treat resolutions or movie names as episodes", () => {
    expect(
      parseEpisode("Movie (2019) [1920x1080]", { allowBare: false })
    ).toBeNull()
    expect(
      parseEpisode(
        "Stuart Little (1999) [imdbid-tt0164912] - [Bluray-1080p][AC3 5.1][x264]-BHDStudio",
        { allowBare: false }
      )
    ).toBeNull()
    expect(parseEpisode("1917", { allowBare: false })).toBeNull()
  })
})

describe("cleanTitle", () => {
  it("folder names", () => {
    expect(cleanTitle("Stuart Little (1999)", { fromFile: false })).toEqual({
      title: "Stuart Little",
      year: 1999,
    })
    expect(cleanTitle("Reacher (2022)", { fromFile: false })).toEqual({
      title: "Reacher",
      year: 2022,
    })
    expect(
      cleanTitle("Batman - The Animated Series", { fromFile: false })
    ).toEqual({ title: "Batman - The Animated Series" })
    expect(
      cleanTitle("A.I.C.O. -Incarnation- (2018)", { fromFile: false })
    ).toEqual({ title: "A.I.C.O. -Incarnation-", year: 2018 })
    expect(cleanTitle("1917 (2019)", { fromFile: false })).toEqual({
      title: "1917",
      year: 2019,
    })
    expect(cleanTitle("2012 (2009)", { fromFile: false })).toEqual({
      title: "2012",
      year: 2009,
    })
    expect(cleanTitle("1917", { fromFile: false })).toEqual({ title: "1917" })
    expect(cleanTitle("Blade Runner 2049 (2017)", { fromFile: false })).toEqual(
      { title: "Blade Runner 2049", year: 2017 }
    )
    expect(cleanTitle("كتكوت", { fromFile: false })).toEqual({ title: "كتكوت" })
    expect(
      cleanTitle("7ENSATION Amazing Jellyfish 8 4K DoVi HLG & AAC 2.0", {
        fromFile: false,
      })
    ).toEqual({
      title: "7ENSATION Amazing Jellyfish 8 4K DoVi HLG & AAC 2.0",
    })
  })
  it("file names", () => {
    expect(
      cleanTitle(
        "Stuart Little (1999) [imdbid-tt0164912] - [Bluray-1080p][AC3 5.1][x264]-BHDStudio",
        { fromFile: true }
      )
    ).toEqual({ title: "Stuart Little", year: 1999 })
    expect(
      cleanTitle(
        "Blade Runner 2049 (2017) {tmdb-335984} [Remux-2160p][HDR10][TrueHD Atmos 7.1][HEVC]-FraMeSToR",
        { fromFile: true }
      )
    ).toEqual({ title: "Blade Runner 2049", year: 2017 })
    expect(
      cleanTitle("The.Amazing.Digital.Circus.S01E02.1080p.WEB.h264-GROUP", {
        fromFile: true,
      })
    ).toEqual({
      title: "The Amazing Digital Circus",
    })
    expect(
      cleanTitle(
        "Auro-3D Channel Test - Noise FHD SDR & Auro-3D DTS-HD MA 11.1 (7+4)",
        { fromFile: true }
      )
    ).toEqual({
      title:
        "Auro-3D Channel Test - Noise FHD SDR & Auro-3D DTS-HD MA 11.1 (7+4)",
    })
    expect(cleanTitle("Spider-Man (2002)", { fromFile: true })).toEqual({
      title: "Spider-Man",
      year: 2002,
    })
  })
})

describe("misc", () => {
  it("video files", () => {
    expect(isVideoFile("a.mkv")).toBe(true)
    expect(isVideoFile("a.MP4")).toBe(true)
    expect(isVideoFile("a.en.srt")).toBe(false)
    expect(isVideoFile("ulshd-frozentf.1080p.sample.mkv")).toBe(false)
    expect(isVideoFile("movie-trailer.mp4")).toBe(false)
    expect(isVideoFile("Sample Movie (2019).mkv")).toBe(false)
    expect(isVideoFile("Samples of Life (2019).mkv")).toBe(true)
  })
  it("library names", () => {
    expect(displayLibraryName("tv 4k")).toBe("TV 4K")
    expect(displayLibraryName("movies")).toBe("Movies")
    expect(displayLibraryName("arabic stage shows")).toBe("Arabic Stage Shows")
    expect(displayLibraryName("demos video")).toBe("Demos Video")
  })
  it("sort keys", () => {
    expect(sortKey("The Matrix")).toBe("matrix")
    expect(sortKey("12 Angry Men") < sortKey("101 Dalmatians")).toBe(true)
    expect(sortKey("Élan")).toBe("elan")
  })
  it("safe names", () => {
    expect(safeName('A: B/C\\D*E?F"G<H>I|J')).toBe("A BCDEFGHIJ")
    expect(safeName("كتكوت")).toBe("كتكوت")
    expect(safeName("  .hidden.  ")).toBe("hidden")
    expect(Buffer.byteLength(safeName("ع".repeat(300)))).toBeLessThanOrEqual(
      200
    )
  })
  it("labels and timestamps", () => {
    expect(episodeLabel(1, 2)).toBe("S01E02")
    expect(episodeLabel(1, 1, 2)).toBe("S01E01-E02")
    expect(episodeLabel(21, 1088, undefined, 4)).toBe("S21E1088")
    expect(formatTimestampForName(754.567)).toBe("00-12-34.567")
    expect(formatTimestampForName(3599.9996)).toBe("01-00-00.000")
    expect(formatTimestampForName(0)).toBe("00-00-00.000")
  })
})

describe("nextCaptureNumber", () => {
  it("starts at 1 and continues after the highest number", () => {
    expect(nextCaptureNumber([])).toBe(1)
    expect(nextCaptureNumber(["1.png", "2.jpg", "3.PNG"])).toBe(4)
    expect(nextCaptureNumber(["2.png", "7.jpg", "4.png"])).toBe(8)
  })

  it("ignores clips, temp files and names that are not plain numbers", () => {
    expect(
      nextCaptureNumber([
        "Arrival (2016) - 00-10-00.000.png",
        "00-10-00.000 to 00-10-05.000.mp4",
        "5.png.tmp.png",
        "1a.png",
        "3.png",
      ])
    ).toBe(4)
  })
})

describe("parseCaptureNumber", () => {
  it("reads plain numbered image names only", () => {
    expect(parseCaptureNumber("7.png")).toBe(7)
    expect(parseCaptureNumber("12.JPG")).toBe(12)
    expect(parseCaptureNumber("7.mp4")).toBeNull()
    expect(parseCaptureNumber("07a.png")).toBeNull()
    expect(parseCaptureNumber("Title - 00-01-00.000.png")).toBeNull()
  })
})
