import { describe, it, expect } from "vitest";
import {
  describeUnusableSshScript,
  readSshScriptSource,
} from "@/lib/skills/ssh-script-source";

const utf8 = (s: string): Buffer => Buffer.from(s, "utf-8");

describe("readSshScriptSource", () => {
  it("accepts plain and multi-byte UTF-8", () => {
    expect(readSshScriptSource(utf8('echo "héllo 🌍"\n'))).toEqual({
      ok: true,
      text: 'echo "héllo 🌍"\n',
    });
  });

  // The regression this guards: Buffer.toString("utf-8") maps ill-formed
  // bytes to U+FFFD and never throws, so mojibake used to reach the host.
  it("rejects bytes that are not valid UTF-8", () => {
    const gbkProbe = Buffer.concat([utf8("# "), Buffer.from([0xc4, 0xe3, 0x0a])]); // 你好 in GBK
    expect(readSshScriptSource(gbkProbe)).toEqual({ ok: false, reason: "NOT_UTF8" });
    expect(readSshScriptSource(Buffer.from([0xff, 0xfe, 0x0a]))).toEqual({
      ok: false,
      reason: "NOT_UTF8",
    });
  });

  it("rejects NUL bytes inside otherwise valid UTF-8", () => {
    expect(readSshScriptSource(utf8("echo \0 hi"))).toEqual({
      ok: false,
      reason: "NUL_BYTES",
    });
  });

  it("strips a leading BOM that both target interpreters reject", () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8("echo hi\n")]);
    expect(readSshScriptSource(withBom)).toEqual({ ok: true, text: "echo hi\n" });
  });

  it("accepts an empty script (the host reports the real error)", () => {
    expect(readSshScriptSource(Buffer.alloc(0))).toEqual({ ok: true, text: "" });
  });
});

describe("describeUnusableSshScript", () => {
  it("names the file and the repair", () => {
    expect(describeUnusableSshScript("scripts/probe.sh", "NOT_UTF8")).toMatch(
      /scripts\/probe\.sh is not valid UTF-8.*Re-save it as UTF-8/,
    );
    expect(describeUnusableSshScript("scripts/probe.py", "NUL_BYTES")).toMatch(
      /scripts\/probe\.py contains NUL bytes/,
    );
  });
});
