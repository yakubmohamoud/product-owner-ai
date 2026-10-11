const path = require('node:path');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const { maximumDocumentBytes } = require('./projectService');

const supportedExtensions = new Set(['.txt', '.md', '.csv', '.json', '.log', '.vtt', '.srt', '.pdf', '.docx', '.xlsx']);

function validateOfficeArchive(input) {
  const minEnd = Math.max(0, input.length - 65557);
  let endOffset = -1;
  for (let offset = input.length - 22; offset >= minEnd; offset -= 1) {
    if (input.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('Office document ZIP directory is invalid.');
  const entryCount = input.readUInt16LE(endOffset + 10);
  const directorySize = input.readUInt32LE(endOffset + 12);
  const directoryOffset = input.readUInt32LE(endOffset + 16);
  if (entryCount > 5000 || directoryOffset + directorySize > endOffset) {
    throw new Error('Office document contains an invalid or excessive ZIP directory.');
  }
  const directoryEnd = directoryOffset + directorySize;
  let offset = directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directoryEnd || input.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Office document ZIP directory is malformed.');
    }
    const compressed = input.readUInt32LE(offset + 20);
    const uncompressed = input.readUInt32LE(offset + 24);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new Error('Zip64 office documents are not supported.');
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > 20 * 1024 * 1024 ||
      uncompressed > Math.max(1024 * 1024, compressed * 50)) {
      throw new Error('Office document expands beyond the safe 20 MB extraction limit.');
    }
    offset += 46 + input.readUInt16LE(offset + 28) +
      input.readUInt16LE(offset + 30) + input.readUInt16LE(offset + 32);
    if (offset > directoryEnd) throw new Error('Office document ZIP directory is malformed.');
  }
  if (offset !== directoryEnd) throw new Error('Office document ZIP directory is malformed.');
}

async function extractText(name, input) {
  const extension = path.extname(name || '').toLowerCase();
  if (!supportedExtensions.has(extension)) {
    throw new Error('Supported documents are text, Markdown, CSV, JSON, logs, VTT, SRT, PDF, DOCX, and XLSX.');
  }
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > maximumDocumentBytes) {
    throw new Error('Each uploaded document must be between 1 byte and 2 MB.');
  }
  if (['.docx', '.xlsx'].includes(extension)) validateOfficeArchive(input);

  let text;
  if (['.pdf', '.docx', '.xlsx'].includes(extension)) {
    if (extension === '.pdf') {
      const parser = new PDFParse({ data: input });
      try {
        const info = await parser.getInfo();
        if (info.total > 150) throw new Error('PDFs are limited to 150 pages per upload.');
        const result = await parser.getText();
        text = result.text;
      } finally {
        await parser.destroy();
      }
    } else if (extension === '.docx') {
      const result = await mammoth.extractRawText({ buffer: input });
      text = result.value;
    } else {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(input);
      text = workbook.worksheets.map((worksheet) => {
        const rows = [];
        worksheet.eachRow((row) => {
          rows.push(row.values.slice(1).map((cell) => {
            if (cell && typeof cell === 'object') return cell.text || cell.result || '';
            return cell ?? '';
          }).join('\t'));
        });
        return `${worksheet.name}\n${rows.join('\n')}`;
      }).join('\n\n');
    }
  } else {
    text = input.toString('utf8');
  }

  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('No readable text was found in this document. Scanned PDFs need OCR before upload.');
  }
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('Extracted document text exceeds the 2 MB limit.');
  }
  return text;
}

module.exports = { extractText, supportedExtensions, validateOfficeArchive };
