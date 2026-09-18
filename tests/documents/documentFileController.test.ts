// puppeteer 25 は ESM 専用で CommonJS の Jest から読めないため、実物を読ませない
jest.mock('puppeteer', () => ({ launch: jest.fn() }));

import { Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: number;
        email: string;
        name: string;
        role: string;
        is_active: boolean;
        supabase_uid: string;
      };
    }
  }
}

const mockPrisma = {
  document: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
};

jest.mock('../../src/db/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
  prisma: mockPrisma,
}));

const mockSaveDocumentFile = jest.fn();
const mockDeleteDocumentFile = jest.fn();
const mockResolveDocumentFilePath = jest.fn();
const mockBuildDocumentFileKey = jest.fn();

jest.mock('../../src/documents/fileStorage', () => ({
  buildDocumentFileKey: (...args: unknown[]) => mockBuildDocumentFileKey(...args),
  saveDocumentFile: (...args: unknown[]) => mockSaveDocumentFile(...args),
  deleteDocumentFile: (...args: unknown[]) => mockDeleteDocumentFile(...args),
  resolveDocumentFilePath: (...args: unknown[]) => mockResolveDocumentFilePath(...args),
}));

import {
  uploadDocumentFile,
  getDocumentDownloadUrl,
  getDocumentFile,
} from '../../src/documents/documentController';

const DOC_UUID = '11111111-1111-4111-8111-111111111111';
const FILE_KEY = `documents/${DOC_UUID}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf`;

const buildResponse = (): Partial<Response> & { download: jest.Mock } => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  download: jest.fn(),
  headersSent: false,
});

const buildRequest = (
  overrides: Partial<{
    params: Record<string, string>;
    file: Partial<Express.Multer.File>;
  }> = {}
): Partial<Request> => ({
  params: overrides.params ?? { id: DOC_UUID },
  file: overrides.file as Express.Multer.File | undefined,
  user: {
    id: 1,
    email: 'operator@example.com',
    name: 'Operator',
    role: 'operator',
    is_active: true,
    supabase_uid: 'op-uid',
  },
});

const buildDocumentRow = (overrides: Record<string, unknown> = {}) => ({
  id: DOC_UUID,
  contract_plot_id: null,
  customer_id: null,
  type: 'other',
  name: 'テスト書類',
  description: null,
  status: 'draft',
  template_type: null,
  template_data: null,
  generated_at: null,
  sent_at: null,
  file_key: null,
  file_name: null,
  file_size: null,
  mime_type: null,
  created_by: 'system',
  notes: null,
  deleted_at: null,
  created_at: new Date('2026-06-01T00:00:00Z'),
  updated_at: new Date('2026-06-01T00:00:00Z'),
  ...overrides,
});

const buildUploadedFile = (
  overrides: Partial<Express.Multer.File> = {}
): Partial<Express.Multer.File> => ({
  fieldname: 'file',
  originalname: 'invoice_2026.pdf',
  mimetype: 'application/pdf',
  size: 1024,
  buffer: Buffer.from('pdf-content'),
  ...overrides,
});

describe('uploadDocumentFile', () => {
  let res: ReturnType<typeof buildResponse>;

  beforeEach(() => {
    jest.clearAllMocks();
    res = buildResponse();
    mockBuildDocumentFileKey.mockReturnValue(FILE_KEY);
    mockSaveDocumentFile.mockResolvedValue(undefined);
    mockDeleteDocumentFile.mockResolvedValue(undefined);
  });

  it('書類が存在しない場合は404を返す', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(null);

    await uploadDocumentFile(
      buildRequest({ file: buildUploadedFile() }) as Request,
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockSaveDocumentFile).not.toHaveBeenCalled();
  });

  it('ファイル未指定の場合は400を返す', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(buildDocumentRow());

    await uploadDocumentFile(buildRequest() as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      })
    );
  });

  it('正常系: ファイル保存とDB更新を行いメタデータを返す', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(buildDocumentRow());
    mockPrisma.document.update.mockResolvedValue(
      buildDocumentRow({
        file_key: FILE_KEY,
        file_name: 'invoice_2026.pdf',
        file_size: 1024,
        mime_type: 'application/pdf',
      })
    );

    await uploadDocumentFile(
      buildRequest({ file: buildUploadedFile() }) as Request,
      res as unknown as Response
    );

    expect(mockSaveDocumentFile).toHaveBeenCalledWith(FILE_KEY, expect.any(Buffer));
    expect(mockPrisma.document.update).toHaveBeenCalledWith({
      where: { id: DOC_UUID },
      data: {
        file_key: FILE_KEY,
        file_name: 'invoice_2026.pdf',
        file_size: 1024,
        mime_type: 'application/pdf',
      },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        id: DOC_UUID,
        fileName: 'invoice_2026.pdf',
        fileSize: 1024,
        mimeType: 'application/pdf',
      },
    });
  });

  it('日本語ファイル名（latin1化け）をUTF-8に復元する', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(buildDocumentRow());
    mockPrisma.document.update.mockResolvedValue(
      buildDocumentRow({
        file_key: FILE_KEY,
        file_name: '請求書.pdf',
        file_size: 1024,
        mime_type: 'application/pdf',
      })
    );
    // ブラウザ送信時のmulterの挙動を再現: UTF-8バイト列をlatin1として解釈した文字列
    const garbled = Buffer.from('請求書.pdf', 'utf8').toString('latin1');

    await uploadDocumentFile(
      buildRequest({ file: buildUploadedFile({ originalname: garbled }) }) as Request,
      res as unknown as Response
    );

    expect(mockPrisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ file_name: '請求書.pdf' }),
      })
    );
  });

  it('差し替え時に旧ファイルを削除する', async () => {
    const previousKey = `documents/${DOC_UUID}/old.pdf`;
    mockPrisma.document.findFirst.mockResolvedValue(buildDocumentRow({ file_key: previousKey }));
    mockPrisma.document.update.mockResolvedValue(
      buildDocumentRow({
        file_key: FILE_KEY,
        file_name: 'invoice_2026.pdf',
        file_size: 1024,
        mime_type: 'application/pdf',
      })
    );

    await uploadDocumentFile(
      buildRequest({ file: buildUploadedFile() }) as Request,
      res as unknown as Response
    );

    expect(mockDeleteDocumentFile).toHaveBeenCalledWith(previousKey);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('旧ファイル削除に失敗してもアップロードは成功扱いにする', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(
      buildDocumentRow({ file_key: `documents/${DOC_UUID}/old.pdf` })
    );
    mockPrisma.document.update.mockResolvedValue(
      buildDocumentRow({
        file_key: FILE_KEY,
        file_name: 'invoice_2026.pdf',
        file_size: 1024,
        mime_type: 'application/pdf',
      })
    );
    mockDeleteDocumentFile.mockRejectedValue(new Error('EACCES'));

    await uploadDocumentFile(
      buildRequest({ file: buildUploadedFile() }) as Request,
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('ファイル保存に失敗した場合は500を返しDBを更新しない', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(buildDocumentRow());
    mockSaveDocumentFile.mockRejectedValue(new Error('ENOSPC'));

    await uploadDocumentFile(
      buildRequest({ file: buildUploadedFile() }) as Request,
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockPrisma.document.update).not.toHaveBeenCalled();
  });
});

describe('getDocumentDownloadUrl', () => {
  let res: ReturnType<typeof buildResponse>;

  beforeEach(() => {
    jest.clearAllMocks();
    res = buildResponse();
  });

  it('書類が存在しない場合は404を返す', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(null);

    await getDocumentDownloadUrl(buildRequest() as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('ファイル未アップロードの場合は404を返す', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(buildDocumentRow());

    await getDocumentDownloadUrl(buildRequest() as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'アップロードされたファイルがありません',
        }),
      })
    );
  });

  it('正常系: 配信エンドポイントの相対URLを返す', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(
      buildDocumentRow({
        file_key: FILE_KEY,
        file_name: 'invoice_2026.pdf',
        mime_type: 'application/pdf',
      })
    );

    await getDocumentDownloadUrl(buildRequest() as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        url: `/api/v1/documents/${DOC_UUID}/file`,
        fileName: 'invoice_2026.pdf',
        mimeType: 'application/pdf',
        expiresIn: 0,
      },
    });
  });
});

describe('getDocumentFile', () => {
  let res: ReturnType<typeof buildResponse>;

  beforeEach(() => {
    jest.clearAllMocks();
    res = buildResponse();
  });

  it('書類が存在しない場合は404を返す', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(null);

    await getDocumentFile(buildRequest() as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.download).not.toHaveBeenCalled();
  });

  it('file_key が無い場合は404を返す', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(buildDocumentRow());

    await getDocumentFile(buildRequest() as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.download).not.toHaveBeenCalled();
  });

  it('file_key が不正な場合は404を返す（パストラバーサル防御）', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(
      buildDocumentRow({ file_key: '../../etc/passwd' })
    );
    mockResolveDocumentFilePath.mockImplementation(() => {
      throw new Error('Invalid file key');
    });

    await getDocumentFile(buildRequest() as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.download).not.toHaveBeenCalled();
  });

  it('正常系: res.download で元のファイル名を付けて配信する', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(
      buildDocumentRow({ file_key: FILE_KEY, file_name: '請求書.pdf' })
    );
    mockResolveDocumentFilePath.mockReturnValue(`/uploads/${FILE_KEY}`);

    await getDocumentFile(buildRequest() as Request, res as unknown as Response);

    expect(mockResolveDocumentFilePath).toHaveBeenCalledWith(FILE_KEY);
    expect(res.download).toHaveBeenCalledWith(
      `/uploads/${FILE_KEY}`,
      '請求書.pdf',
      expect.any(Function)
    );
  });

  it('ファイル実体が無い場合（downloadコールバックエラー）は404を返す', async () => {
    mockPrisma.document.findFirst.mockResolvedValue(
      buildDocumentRow({ file_key: FILE_KEY, file_name: 'invoice.pdf' })
    );
    mockResolveDocumentFilePath.mockReturnValue(`/uploads/${FILE_KEY}`);
    res.download.mockImplementation((_path: string, _name: string, cb: (err?: Error) => void) => {
      cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    await getDocumentFile(buildRequest() as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
