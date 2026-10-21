/**
 * @chat/security-sanitizer
 * Enforces PII Masking, Message Sanitization, and Client-Side Media Upload Validation
 * in strict compliance with docs/03-frontend-design-specification.md.
 */

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
]);

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.pdf']);
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export function maskEmail(email: string): string {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return '***@***';
  }
  const [localPart, domain] = email.trim().split('@');
  if (!localPart || !domain) {
    return '***@***';
  }
  const visibleStart = localPart.slice(0, 1);
  return `${visibleStart}***@${domain}`;
}

export function maskPhoneNumber(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    return '***-***-****';
  }
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) {
    return '***-***-****';
  }
  return `***-***-${digits.slice(-4)}`;
}

export function maskIdentifier(idStr: string): string {
  if (!idStr || typeof idStr !== 'string' || idStr.length <= 6) {
    return '***';
  }
  return `${idStr.slice(0, 4)}***${idStr.slice(-3)}`;
}

export function sanitizeMessageText(raw: string): {
  valid: boolean;
  sanitized: string;
  error?: string;
} {
  if (typeof raw !== 'string') {
    return { valid: false, sanitized: '', error: 'Message content must be a string.' };
  }
  // Remove non-printable ASCII control chars except newline (\n) and tab (\t)
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  if (cleaned.length === 0) {
    return { valid: false, sanitized: '', error: 'Message content cannot be empty.' };
  }
  if (cleaned.length > 4096) {
    return {
      valid: false,
      sanitized: cleaned.slice(0, 4096),
      error: 'Message content exceeds maximum length of 4096 characters.',
    };
  }
  return { valid: true, sanitized: cleaned };
}

export function validateAttachmentMetadata(input: {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}): { valid: boolean; reason?: string } {
  const { filename, mimeType, sizeBytes } = input;
  if (!filename || typeof filename !== 'string') {
    return { valid: false, reason: 'Filename is required.' };
  }

  // Prevent path traversal sequences or null bytes
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    return { valid: false, reason: 'Invalid filename: path traversal characters are prohibited.' };
  }

  const lower = filename.toLowerCase().trim();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx <= 0) {
    return { valid: false, reason: 'File must have a valid extension.' };
  }

  const ext = lower.slice(dotIdx);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      reason: `Unsupported file extension "${ext}". Allowed: .png, .jpg, .webp, .pdf.`,
    };
  }

  // Block dangerous double extensions (e.g. payload.exe.png or script.svg.png)
  const baseName = lower.slice(0, dotIdx);
  if (/\.(exe|bat|cmd|sh|js|html|svg|php|py)$/i.test(baseName)) {
    return {
      valid: false,
      reason: 'Suspicious double file extension detected.',
    };
  }

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return {
      valid: false,
      reason: `Unsupported MIME type "${mimeType}".`,
    };
  }

  if (typeof sizeBytes !== 'number' || sizeBytes <= 0) {
    return { valid: false, reason: 'File size must be greater than 0 bytes.' };
  }

  if (sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    return {
      valid: false,
      reason: `File size exceeds maximum limit of 10 MB (${MAX_UPLOAD_SIZE_BYTES} bytes).`,
    };
  }

  return { valid: true };
}
