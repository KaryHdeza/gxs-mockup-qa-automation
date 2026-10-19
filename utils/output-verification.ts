
import fs from 'node:fs';
import { imageSize } from 'image-size';
import { PDFDocument } from 'pdf-lib';
import type { ExportFormat } from './config.js';

export type OutputVerification = {
  detectedFormat: string;
  width: number | null;
  height: number | null;
  pdfPageWidthPt: number | null;
  pdfPageHeightPt: number | null;
  fileBytes: number;
};

function normalizeImageFormat(format: string): string {
  const normalized = format.trim().toLowerCase();

  if (normalized === 'jpg' || normalized === 'jpeg') {
    return 'jpeg';
  }

  return normalized;
}

export async function verifyOutput(
  filePath: string,
  expectedFormat: ExportFormat,
  expectedWidth: number,
  expectedHeight: number
): Promise<OutputVerification> {
  const bytes = fs.readFileSync(filePath);

  if (expectedFormat === 'PDF') {
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error(
        'OUTPUT_FORMAT_MISMATCH: downloaded output does not have a PDF signature.'
      );
    }

    const document = await PDFDocument.load(bytes);
    const pages = document.getPages();

    if (pages.length === 0) {
      throw new Error(
        'OUTPUT_INVALID_PDF: document contains no pages.'
      );
    }

    const size = pages[0].getSize();

    return {
      detectedFormat: 'PDF',
      width: null,
      height: null,
      pdfPageWidthPt: size.width,
      pdfPageHeightPt: size.height,
      fileBytes: bytes.length
    };
  }

  const image = imageSize(bytes);

  if (!image.type) {
    throw new Error(
      'OUTPUT_FORMAT_UNRECOGNIZED: image format could not be identified.'
    );
  }

  const expectedType = normalizeImageFormat(expectedFormat);
  const actualType = normalizeImageFormat(image.type);

  if (expectedType !== actualType) {
    throw new Error(
      `OUTPUT_FORMAT_MISMATCH: requested ${expectedFormat}, received ${image.type}.`
    );
  }

  if (
    image.width !== expectedWidth ||
    image.height !== expectedHeight
  ) {
    throw new Error(
      `OUTPUT_DIMENSION_MISMATCH: expected ${expectedWidth} x ${expectedHeight} px, received ${image.width} x ${image.height} px.`
    );
  }

  return {
    detectedFormat: actualType.toUpperCase(),
    width: image.width,
    height: image.height,
    pdfPageWidthPt: null,
    pdfPageHeightPt: null,
    fileBytes: bytes.length
  };
}
