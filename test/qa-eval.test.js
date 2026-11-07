// test/qa-eval.test.js — bench/qa-eval.mjs 的三个不变量
//
// 1) 问题里不得出现答案，且 prompt 不得泄漏原文（span.text）
// 2) 判分严格是字符串包含：答对算 pass，答错算 fail
// 3) 出题按类型轮转、确定性可复现

import test from "node:test";
import assert from "node:assert/strict";

import { buildPrompts, grade, selectAnchors, classifyAnchor } from "../bench/qa-eval.mjs";

// 一份合成 span：每类锚点都放几条，够验证轮转与防泄题。
const SPAN_TEXT = [
  "OPEN /vol3/1000/work/rootfs.img",
  "MOUNT /vol3/1000/work/boot_a.img",
  "COPY /vol3/1000/work/dtb.a.dtb",
  "UUID 9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
  "HANDLE 1234abcd-0000-1111-2222-333344445555",
  "MAP 0x0000ffaa1b2c3d4e",
  "env DSH_PROFILE_ROOT_DIR=/x",
  "failed to open /dev/disk3s1 with errno 5",
  "sync took 512ms",
  "run adb shell dumpsys battery"
].join("\n");

const SPAN = {
  source: "fixture.jsonl.zstd",
  spanSource: "compaction c0007",
  tokensEstimate: 1234,
  text: SPAN_TEXT,
  canaries: [
    "/vol3/1000/work/rootfs.img",
    "/vol3/1000/work/boot_a.img",
    "/vol3/1000/work/dtb.a.dtb",
    "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
    "1234abcd-0000-1111-2222-333344445555",
    "0x0000ffaa1b2c3d4e",
    "DSH_PROFILE_ROOT_DIR",
    "failed to open /dev/disk3s1 with errno 5",
    "512ms",
    "adb shell dumpsys battery"
  ]
};

test("问题文本不含答案，prompt 不泄漏 span 原文", () => {
  const { questions, prompt } = buildPrompts(SPAN, 8, "SUMMARY: 只提到磁盘与启动镜像。");
  assert.ok(questions.length > 0, "至少要出到题");
  for (const item of questions) {
    assert.ok(!item.question.includes(item.anchor), "问题泄漏了答案: " + item.question);
  }
  // 答题 prompt 只能有摘要，不能塞原文（那才是“压缩后还能答吗”）
  assert.ok(!prompt.includes("OPEN /vol3/1000/work/rootfs.img"));
  assert.ok(prompt.includes("SUMMARY: 只提到磁盘与启动镜像。"));
});

test("判分：答对 pass、答错 fail", () => {
  const questions = [
    { type: "path", anchor: "/vol3/1000/work/rootfs.img", question: "q1" },
    { type: "number", anchor: "512ms", question: "q2" }
  ];
  const answers = "Q1: it was /vol3/1000/work/rootfs.img exactly\nQ2: about half a second\n";
  const result = grade(SPAN, questions, answers);
  assert.equal(result.n, 2);
  assert.equal(result.answered, 2);
  assert.equal(result.correct, 1);
  assert.equal(result.rate, 0.5);
  assert.equal(result.perQuestion[0].pass, true);
  assert.equal(result.perQuestion[1].pass, false);
  // 大小写敏感：改一个字符就不算命中
  const cased = grade(SPAN, questions, "Q1: /VOL3/1000/work/rootfs.img\n");
  assert.equal(cased.perQuestion[0].pass, false);
  assert.equal(cased.answered, 1);
  assert.equal(cased.rate, 0);
});

test("n 条题目按类型轮转且确定性", () => {
  // 类型名排序后轮转：第一轮把每种类型各取一条（7 种类型），
  // 第二轮折回，只剩 path 还有余量，所以第 8 题是 path。
  const firstRound = selectAnchors(SPAN, 7).map((entry) => entry.type);
  assert.deepEqual(firstRound, ["command", "env", "error", "hex", "number", "path", "uuid"]);
  const wrapped = selectAnchors(SPAN, 8).map((entry) => entry.type);
  assert.deepEqual(wrapped.slice(7), ["path"]);
  // 同一输入两次结果一致（不随机）
  assert.deepEqual(
    buildPrompts(SPAN, 6).questions.map((q) => q.anchor),
    buildPrompts(SPAN, 6).questions.map((q) => q.anchor)
  );
  // 类型识别与 anchors.mjs 的 pattern 对齐
  assert.equal(classifyAnchor("0x0000ffaa1b2c3d4e"), "hex");
  assert.equal(classifyAnchor("/vol3/1000/work/rootfs.img"), "path");
});
