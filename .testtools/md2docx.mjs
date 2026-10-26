/**
 * 把 测试报告/*.md 转成 Word 文档，图片以【二进制内嵌】方式放进 docx
 * —— 打开文档就能看到截图，不是外链，也不依赖 screenshots 目录还在不在。
 *
 * 输出：
 *   ECHO-全功能测试报告.docx   （九份合并，按板块分页）
 *   每个板块一个同名 .docx
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  PageBreak,
} from 'docx';

const ROOT = 'c:/Users/Administrator/Desktop/yx/测试报告';
const PAGE_W = 9360; // A4 可用宽度（twips，约 6.5 英寸）
const MAX_IMG_W = 570; // 截图最大宽度（像素 @96dpi）

function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** **粗体** 与 `行内代码` */
function runs(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(new TextRun(text.slice(last, m.index)));
    const t = m[0];
    if (t.startsWith('**')) out.push(new TextRun({ text: t.slice(2, -2), bold: true }));
    else out.push(new TextRun({ text: t.slice(1, -1), font: 'Consolas' }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun(text.slice(last)));
  return out.length ? out : [new TextRun('')];
}

function imageParagraph(absPath, alt) {
  if (!fs.existsSync(absPath)) {
    return new Paragraph({ children: [new TextRun({ text: `[缺少图片: ${alt}]`, color: 'C00000' })] });
  }
  const buf = fs.readFileSync(absPath);
  const { w, h } = pngSize(buf);
  const width = Math.min(MAX_IMG_W, w);
  const height = Math.round((width * h) / w);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 60 },
    children: [new ImageRun({ data: buf, transformation: { width, height } })],
  });
}

const cellBorder = {
  top: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
  bottom: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
  left: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
  right: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
};

function tableNode(rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  const colW = Math.floor(PAGE_W / cols);
  return new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    rows: rows.map((cells, ri) =>
      new TableRow({
        children: Array.from({ length: cols }, (_, ci) => {
          const raw = (cells[ci] ?? '').trim();
          return new TableCell({
            width: { size: colW, type: WidthType.DXA },
            borders: cellBorder,
            shading: ri === 0 ? { fill: 'F2F4F8' } : undefined,
            children: [new Paragraph({ children: runs(raw), spacing: { after: 0 } })],
          });
        }),
      })
    ),
  });
}

const HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
};

/** md 文本 → docx 顶层块数组 */
function mdToBlocks(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (line.trim().startsWith('```')) {
      i++;
      const code = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push(
        ...code.map(
          (c) =>
            new Paragraph({
              children: [new TextRun({ text: c || ' ', font: 'Consolas', size: 20 })],
              spacing: { after: 0 },
            })
        )
      );
      blocks.push(new Paragraph({ children: [new TextRun('')] }));
      continue;
    }

    // 表格
    if (line.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const raw = lines[i].trim();
        if (!/^\|[\s:|-]+\|$/.test(raw)) {
          rows.push(
            raw
              .replace(/^\||\|$/g, '')
              .split('|')
              .map((c) => c.trim())
          );
        }
        i++;
      }
      if (rows.length) blocks.push(tableNode(rows));
      continue;
    }

    // 图片
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      const alt = img[1];
      const rel = img[2].replace(/^\.\//, '');
      blocks.push(imageParagraph(path.join(ROOT, rel), alt));
      // 图注
      if (alt) {
        blocks.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 160 },
            children: [new TextRun({ text: alt, size: 18, color: '808080' })],
          })
        );
      }
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push(new Paragraph({ text: h[2].trim(), heading: HEADINGS[h[1].length] }));
      i++;
      continue;
    }

    // 分隔线
    if (/^---+$/.test(line.trim())) {
      blocks.push(new Paragraph({ children: [new TextRun('')] }));
      i++;
      continue;
    }

    // 引用
    if (line.startsWith('>')) {
      blocks.push(
        new Paragraph({
          indent: { left: 360 },
          children: [new TextRun({ text: line.replace(/^>\s?/, ''), italics: true, color: '555555' })],
        })
      );
      i++;
      continue;
    }

    // 列表
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      blocks.push(new Paragraph({ children: runs(li[1]), bullet: { level: 0 } }));
      i++;
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 普通段落
    blocks.push(new Paragraph({ children: runs(line), spacing: { after: 120 } }));
    i++;
  }

  return blocks;
}

const FILES = [
  '00-总览.md',
  '01-登录与开场.md',
  '02-房间与联机.md',
  '03-校园地图.md',
  '04-七关场景巡礼.md',
  '05-角色能力与技能.md',
  '06-关卡机关.md',
  '07-移动端与独行.md',
  '08-结尾与后台系统.md',
  '09-后台管理系统.md',
];

const docOpts = {
  styles: {
    default: {
      document: { run: { font: 'Microsoft YaHei', size: 22 } },
    },
  },
};

// ---------- 1) 每个板块一个 docx
for (const f of FILES) {
  const md = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const doc = new Document({ ...docOpts, sections: [{ children: mdToBlocks(md) }] });
  const buf = await Packer.toBuffer(doc);
  const out = path.join(ROOT, f.replace(/\.md$/, '.docx'));
  fs.writeFileSync(out, buf);
  console.log('生成', path.basename(out), (buf.length / 1024).toFixed(0) + ' KB');
}

// ---------- 2) 合并成一份完整报告（板块之间分页）
const merged = [];
FILES.forEach((f, idx) => {
  if (idx > 0) merged.push(new Paragraph({ children: [new PageBreak()] }));
  merged.push(...mdToBlocks(fs.readFileSync(path.join(ROOT, f), 'utf8')));
});
const full = new Document({ ...docOpts, sections: [{ children: merged }] });
const fullBuf = await Packer.toBuffer(full);
const fullOut = path.join(ROOT, 'ECHO-全功能测试报告.docx');
fs.writeFileSync(fullOut, fullBuf);
console.log('生成', path.basename(fullOut), (fullBuf.length / 1024).toFixed(0) + ' KB');
