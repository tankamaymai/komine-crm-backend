/**
 * 書類管理コントローラー
 *
 * 設計方針:
 * - PDFはオンデマンド生成してブラウザに直接返す（Base64）
 * - DBにはメタデータ（template_data等）のみ保存
 * - 再度必要な場合はtemplate_dataから再生成可能
 * - 添付ファイル（アップロード）はローカルディレクトリ（UPLOAD_DIR）に保存し、
 *   DBには file_key（相対パス）とメタデータを保存する（fileStorage.ts 参照）
 */

import { Request, Response } from 'express';
import { Prisma, type DocumentType, type DocumentStatus } from '@prisma/client';
import { ZodError } from 'zod';
import { getRequestLogger } from '../utils/logger';
import { generatePdfFromTemplate } from './documentService';
import {
  type DocumentTemplateType,
  type PdfTemplateData,
  DOCUMENT_TEMPLATE_TYPES,
  sanitizeDocumentFileName,
} from '@komine/types';
import { generatePdfRequestSchema, parseTemplateData } from '../validations/documentValidation';
import prisma from '../db/prisma';
import {
  buildDocumentFileKey,
  deleteDocumentFile,
  resolveDocumentFilePath,
  saveDocumentFile,
} from './fileStorage';
import {
  recordDocumentCreated,
  recordDocumentUpdated,
  recordDocumentDeleted,
} from '../plots/services/historyService';

// リクエスト型定義
interface CreateDocumentBody {
  contractPlotId?: string;
  customerId?: string;
  type: DocumentType;
  name: string;
  description?: string;
  templateType?: string;
  templateData?: Record<string, unknown>;
  notes?: string;
}

interface UpdateDocumentBody {
  name?: string;
  description?: string;
  status?: DocumentStatus;
  templateData?: Record<string, unknown>;
  notes?: string;
}

interface DocumentListQuery {
  contractPlotId?: string;
  customerId?: string;
  type?: DocumentType;
  status?: DocumentStatus;
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// テンプレートタイプ → 書類種別 / 表示名のマップ。
// `Record<DocumentTemplateType, ...>` で縛ることで、新テンプレート追加時に
// コンパイラが未対応をエラーで教えてくれる。
const TEMPLATE_TYPE_TO_DOC_TYPE: Record<DocumentTemplateType, DocumentType> = {
  invoice: 'invoice',
  postcard: 'postcard',
  permit: 'permit',
  'envelope-letter': 'envelope_letter',
  'envelope-base': 'envelope_base',
  'payment-guide': 'other',
};

const TEMPLATE_TYPE_TO_NAME: Record<DocumentTemplateType, string> = {
  invoice: '護持費のお知らせ',
  postcard: 'はがき',
  permit: '許可証',
  'envelope-letter': '封筒書',
  'envelope-base': '封筒大',
  'payment-guide': 'お支払い方法のご案内',
};

function isDocumentTemplateType(value: unknown): value is DocumentTemplateType {
  return (
    typeof value === 'string' && (DOCUMENT_TEMPLATE_TYPES as readonly string[]).includes(value)
  );
}

function formatZodIssues(err: ZodError): Array<{ field: string; message: string }> {
  return err.issues.map((issue) => ({
    field: issue.path.join('.') || '',
    message: issue.message,
  }));
}

/**
 * 書類が参照する FK (contractPlotId / customerId) の存在を確認する。
 * Zod の UUID 形式チェックだけでは実在しないIDで `prisma.document.create` が
 * P2003 (FK 違反) で 500 化するため、createDocument / generatePdf の双方から
 * この関数を呼んで明示的な 400 を返す。
 *
 * 戻り値: 検証 OK なら null、NG なら 400 用エラーペイロード。
 */
async function validateDocumentRefs(
  contractPlotId: string | null | undefined,
  customerId: string | null | undefined
): Promise<{ code: 'VALIDATION_ERROR'; message: string } | null> {
  if (contractPlotId) {
    const exists = await prisma.contractPlot.findFirst({
      where: { id: contractPlotId, deleted_at: null },
      select: { id: true },
    });
    if (!exists) {
      return { code: 'VALIDATION_ERROR', message: '指定された契約区画が見つかりません' };
    }
  }
  if (customerId) {
    const exists = await prisma.customer.findFirst({
      where: { id: customerId, deleted_at: null },
      select: { id: true },
    });
    if (!exists) {
      return { code: 'VALIDATION_ERROR', message: '指定された顧客が見つかりません' };
    }
  }
  return null;
}

/**
 * 書類一覧取得
 */
export const getDocuments = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      contractPlotId,
      customerId,
      type,
      status,
      page = '1',
      limit = '20',
      sortBy = 'created_at',
      sortOrder = 'desc',
    } = req.query as DocumentListQuery;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    // フィルター条件構築
    const where: {
      deleted_at: null;
      contract_plot_id?: string;
      customer_id?: string;
      type?: DocumentType;
      status?: DocumentStatus;
    } = {
      deleted_at: null,
    };

    if (contractPlotId) where.contract_plot_id = contractPlotId;
    if (customerId) where.customer_id = customerId;
    if (type) where.type = type;
    if (status) where.status = status;

    // ソート設定
    const allowedSortFields = ['created_at', 'updated_at', 'name', 'type', 'status'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
    const orderBy = { [sortField]: sortOrder === 'asc' ? 'asc' : 'desc' };

    // データ取得
    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        include: {
          contractPlot: {
            select: {
              id: true,
              physicalPlot: {
                select: {
                  plot_number: true,
                  display_number: true,
                  area_name: true,
                },
              },
            },
          },
          customer: {
            select: {
              id: true,
              name: true,
              name_kana: true,
            },
          },
        },
        orderBy,
        skip,
        take: limitNum,
      }),
      prisma.document.count({ where }),
    ]);

    // レスポンス形式に変換
    const items = documents.map((doc) => ({
      id: doc.id,
      contractPlotId: doc.contract_plot_id,
      customerId: doc.customer_id,
      type: doc.type,
      name: doc.name,
      description: doc.description,
      status: doc.status,
      templateType: doc.template_type,
      generatedAt: doc.generated_at?.toISOString() || null,
      sentAt: doc.sent_at?.toISOString() || null,
      fileName: doc.file_name,
      fileSize: doc.file_size,
      mimeType: doc.mime_type,
      createdBy: doc.created_by,
      notes: doc.notes,
      createdAt: doc.created_at.toISOString(),
      updatedAt: doc.updated_at.toISOString(),
      contractPlot: doc.contractPlot
        ? {
            id: doc.contractPlot.id,
            plotNumber: doc.contractPlot.physicalPlot.plot_number,
            displayNumber: doc.contractPlot.physicalPlot.display_number,
            areaName: doc.contractPlot.physicalPlot.area_name,
          }
        : null,
      customer: doc.customer
        ? {
            id: doc.customer.id,
            name: doc.customer.name,
            nameKana: doc.customer.name_kana,
          }
        : null,
    }));

    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error fetching documents');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '書類一覧の取得に失敗しました',
      },
    });
  }
};

/**
 * 書類詳細取得
 */
export const getDocumentById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;

    const document = await prisma.document.findFirst({
      where: { id, deleted_at: null },
      include: {
        contractPlot: {
          select: {
            id: true,
            contract_area_sqm: true,
            contract_date: true,
            physicalPlot: {
              select: {
                id: true,
                plot_number: true,
                display_number: true,
                area_name: true,
              },
            },
          },
        },
        customer: {
          select: {
            id: true,
            name: true,
            name_kana: true,
            postal_code: true,
            address: true,
            phone_number: true,
            email: true,
          },
        },
      },
    });

    if (!document) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '書類が見つかりません',
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        id: document.id,
        contractPlotId: document.contract_plot_id,
        customerId: document.customer_id,
        type: document.type,
        name: document.name,
        description: document.description,
        status: document.status,
        templateType: document.template_type,
        templateData: document.template_data,
        generatedAt: document.generated_at?.toISOString() || null,
        sentAt: document.sent_at?.toISOString() || null,
        fileKey: document.file_key,
        fileName: document.file_name,
        fileSize: document.file_size,
        mimeType: document.mime_type,
        createdBy: document.created_by,
        notes: document.notes,
        createdAt: document.created_at.toISOString(),
        updatedAt: document.updated_at.toISOString(),
        contractPlot: document.contractPlot
          ? {
              id: document.contractPlot.id,
              contractAreaSqm: Number(document.contractPlot.contract_area_sqm),
              contractDate: document.contractPlot.contract_date?.toISOString() || null,
              physicalPlot: {
                id: document.contractPlot.physicalPlot.id,
                plotNumber: document.contractPlot.physicalPlot.plot_number,
                displayNumber: document.contractPlot.physicalPlot.display_number,
                areaName: document.contractPlot.physicalPlot.area_name,
              },
            }
          : null,
        customer: document.customer
          ? {
              id: document.customer.id,
              name: document.customer.name,
              nameKana: document.customer.name_kana,
              postalCode: document.customer.postal_code,
              address: document.customer.address,
              phoneNumber: document.customer.phone_number,
              email: document.customer.email,
            }
          : null,
      },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error fetching document');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '書類の取得に失敗しました',
      },
    });
  }
};

/**
 * 書類メタデータ作成
 */
export const createDocument = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as CreateDocumentBody;
    const {
      contractPlotId,
      customerId,
      type,
      name,
      description,
      templateType,
      templateData,
      notes,
    } = body;

    // 必須フィールド検証
    if (!type || !name) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'type と name は必須です',
        },
      });
      return;
    }

    // 関連データの存在確認
    const refError = await validateDocumentRefs(contractPlotId, customerId);
    if (refError) {
      res.status(400).json({ success: false, error: refError });
      return;
    }

    const document = await prisma.document.create({
      data: {
        contract_plot_id: contractPlotId || null,
        customer_id: customerId || null,
        type,
        name,
        description: description || null,
        template_type: templateType || null,
        template_data: templateData
          ? (templateData as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        notes: notes || null,
        created_by: req.user?.name || req.user?.email || 'system',
      },
    });

    // 履歴記録
    await recordDocumentCreated(prisma, document, req);

    res.status(201).json({
      success: true,
      data: {
        id: document.id,
        contractPlotId: document.contract_plot_id,
        customerId: document.customer_id,
        type: document.type,
        name: document.name,
        description: document.description,
        status: document.status,
        templateType: document.template_type,
        templateData: document.template_data,
        notes: document.notes,
        createdBy: document.created_by,
        createdAt: document.created_at.toISOString(),
        updatedAt: document.updated_at.toISOString(),
      },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error creating document');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '書類の作成に失敗しました',
      },
    });
  }
};

/**
 * 書類更新
 */
export const updateDocument = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;
    const body = req.body as UpdateDocumentBody;
    const { name, description, status, templateData, notes } = body;

    const existingDocument = await prisma.document.findFirst({
      where: { id, deleted_at: null },
    });

    if (!existingDocument) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '書類が見つかりません',
        },
      });
      return;
    }

    const updateData: Prisma.DocumentUpdateInput = {};

    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description || null;
    if (status !== undefined) {
      updateData.status = status;
      if (status === 'sent' && !existingDocument.sent_at) {
        updateData.sent_at = new Date();
      }
    }
    if (templateData !== undefined) {
      updateData.template_data = templateData
        ? (templateData as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull;
    }
    if (notes !== undefined) updateData.notes = notes || null;

    const document = await prisma.document.update({
      where: { id },
      data: updateData,
    });

    // 履歴記録
    await recordDocumentUpdated(
      prisma,
      {
        name: existingDocument.name,
        description: existingDocument.description,
        status: existingDocument.status,
        notes: existingDocument.notes,
      },
      {
        name: document.name,
        description: document.description,
        status: document.status,
        notes: document.notes,
      },
      document.id,
      document.contract_plot_id,
      req
    );

    res.status(200).json({
      success: true,
      data: {
        id: document.id,
        contractPlotId: document.contract_plot_id,
        customerId: document.customer_id,
        type: document.type,
        name: document.name,
        description: document.description,
        status: document.status,
        templateType: document.template_type,
        templateData: document.template_data,
        generatedAt: document.generated_at?.toISOString() || null,
        sentAt: document.sent_at?.toISOString() || null,
        fileName: document.file_name,
        fileSize: document.file_size,
        mimeType: document.mime_type,
        notes: document.notes,
        createdAt: document.created_at.toISOString(),
        updatedAt: document.updated_at.toISOString(),
      },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error updating document');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '書類の更新に失敗しました',
      },
    });
  }
};

/**
 * 書類削除（論理削除）
 */
export const deleteDocument = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;

    const existingDocument = await prisma.document.findFirst({
      where: { id, deleted_at: null },
    });

    if (!existingDocument) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '書類が見つかりません',
        },
      });
      return;
    }

    await prisma.document.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    // 履歴記録
    await recordDocumentDeleted(prisma, existingDocument, req);

    res.status(200).json({
      success: true,
      data: { message: '書類を削除しました' },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error deleting document');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '書類の削除に失敗しました',
      },
    });
  }
};

/**
 * PDF生成（オンデマンド）
 * テンプレートとデータからPDFを生成し、Base64で直接返す。
 * DBにはメタデータのみ保存し、ファイルは保存しない。
 */
export const generatePdf = async (req: Request, res: Response): Promise<void> => {
  try {
    // Zod で discriminated union として検証。
    // templateType / templateData の必須チェック・テンプレートタイプ列挙・
    // データの形まで一括で弾ける。
    const parsed = generatePdfRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'リクエストの形式が不正です',
          details: formatZodIssues(parsed.error),
        },
      });
      return;
    }
    const { templateType, templateData, documentId, name, contractPlotId, customerId } =
      parsed.data;

    // 関連データの存在確認（Zod は UUID 形式しか見ないため、
    // ここで実在チェックしないと document.create で FK 違反 (P2003) → 500 になる）
    const refError = await validateDocumentRefs(contractPlotId, customerId);
    if (refError) {
      res.status(400).json({ success: false, error: refError });
      return;
    }

    // PDF生成
    const pdfResult = await generatePdfFromTemplate(templateType, templateData as PdfTemplateData);

    if (!pdfResult.success || !pdfResult.buffer) {
      res.status(500).json({
        success: false,
        error: {
          code: 'PDF_GENERATION_ERROR',
          message: pdfResult.error || 'PDF生成に失敗しました',
        },
      });
      return;
    }

    // documentIdが指定されている場合は既存書類のメタデータを更新
    if (documentId) {
      const existingDocument = await prisma.document.findFirst({
        where: { id: documentId, deleted_at: null },
      });

      if (!existingDocument) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: '書類が見つかりません',
          },
        });
        return;
      }

      // テンプレート種別の不一致を早期拒否する（#230）。
      // 旧 template_type のまま template_data だけ新種別形状で上書きすると、
      // regeneratePdf の parseTemplateData(旧種別, 新形状データ) が ZodError になり
      // 再生成不能な破損データが生まれる。
      if (existingDocument.template_type && existingDocument.template_type !== templateType) {
        res.status(400).json({
          success: false,
          error: {
            code: 'TEMPLATE_TYPE_MISMATCH',
            message: `指定書類のテンプレート種別（${existingDocument.template_type}）とリクエストの種別（${templateType}）が一致しません`,
          },
        });
        return;
      }

      const updatedDocument = await prisma.document.update({
        where: { id: documentId },
        data: {
          status: 'generated',
          generated_at: new Date(),
          // template_type 未設定の書類にも種別を保存し、template_data と常に整合させる（#230）
          template_type: templateType,
          type: TEMPLATE_TYPE_TO_DOC_TYPE[templateType],
          template_data: templateData as unknown as Prisma.InputJsonValue,
        },
      });

      // 履歴記録: PDF再発行による status / generated_at の更新を追跡
      await recordDocumentUpdated(
        prisma,
        {
          status: existingDocument.status,
          generated_at: existingDocument.generated_at,
        },
        {
          status: updatedDocument.status,
          generated_at: updatedDocument.generated_at,
        },
        updatedDocument.id,
        updatedDocument.contract_plot_id,
        req
      );

      res.status(200).json({
        success: true,
        data: {
          documentId,
          pdf: pdfResult.buffer.toString('base64'),
          mimeType: 'application/pdf',
          fileSize: pdfResult.buffer.length,
        },
      });
      return;
    }

    // 新規書類メタデータを作成
    const documentType = TEMPLATE_TYPE_TO_DOC_TYPE[templateType];
    const documentName = name || `${TEMPLATE_TYPE_TO_NAME[templateType]}_${Date.now()}`;

    const newDocument = await prisma.document.create({
      data: {
        contract_plot_id: contractPlotId || null,
        customer_id: customerId || null,
        type: documentType,
        name: documentName,
        status: 'generated',
        mime_type: 'application/pdf',
        file_size: pdfResult.buffer.length,
        template_type: templateType,
        template_data: templateData as unknown as Prisma.InputJsonValue,
        generated_at: new Date(),
        created_by: req.user?.name || req.user?.email || 'system',
      },
    });

    // 履歴記録: 書類発行（generate-pdf 経由の新規作成）
    await recordDocumentCreated(prisma, newDocument, req);

    res.status(201).json({
      success: true,
      data: {
        documentId: newDocument.id,
        pdf: pdfResult.buffer.toString('base64'),
        mimeType: 'application/pdf',
        fileSize: pdfResult.buffer.length,
      },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error generating PDF');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'PDF生成に失敗しました',
      },
    });
  }
};

/**
 * 既存書類のPDFを再生成
 * DBに保存されたtemplate_dataを使ってPDFをオンデマンド再生成する。
 */
export const regeneratePdf = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;

    const document = await prisma.document.findFirst({
      where: { id, deleted_at: null },
    });

    if (!document) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '書類が見つかりません',
        },
      });
      return;
    }

    if (!document.template_type || !document.template_data) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NO_TEMPLATE_DATA',
          message: 'テンプレートデータが保存されていないため、再生成できません',
        },
      });
      return;
    }

    // テンプレートタイプ検証
    if (!isDocumentTemplateType(document.template_type)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TEMPLATE',
          message: '無効なテンプレートタイプです',
        },
      });
      return;
    }

    // 保存されている template_data を Zod で復元（壊れたデータを早期に検出）
    let templateData: PdfTemplateData;
    try {
      templateData = parseTemplateData(document.template_type, document.template_data);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_TEMPLATE_DATA',
            message: '保存されたテンプレートデータの形式が不正です',
            details: formatZodIssues(err),
          },
        });
        return;
      }
      throw err;
    }

    // PDF再生成
    const pdfResult = await generatePdfFromTemplate(document.template_type, templateData);

    if (!pdfResult.success || !pdfResult.buffer) {
      res.status(500).json({
        success: false,
        error: {
          code: 'PDF_GENERATION_ERROR',
          message: pdfResult.error || 'PDF再生成に失敗しました',
        },
      });
      return;
    }

    // PDF を再発行したので generated_at を更新し、履歴に残す
    const regeneratedAt = new Date();
    await prisma.document.update({
      where: { id: document.id },
      data: { generated_at: regeneratedAt },
    });
    await recordDocumentUpdated(
      prisma,
      { generated_at: document.generated_at },
      { generated_at: regeneratedAt },
      document.id,
      document.contract_plot_id,
      req
    );

    const fileName = sanitizeDocumentFileName(document.name);

    res.status(200).json({
      success: true,
      data: {
        documentId: document.id,
        pdf: pdfResult.buffer.toString('base64'),
        mimeType: 'application/pdf',
        fileSize: pdfResult.buffer.length,
        fileName,
      },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error regenerating PDF');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'PDF再生成に失敗しました',
      },
    });
  }
};

/**
 * 書類ファイルアップロード
 * multipart/form-data の file を UPLOAD_DIR 配下へ保存し、
 * Document の file_key / file_name / file_size / mime_type を更新する。
 */
export const uploadDocumentFile = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;

    const document = await prisma.document.findFirst({
      where: { id, deleted_at: null },
    });

    if (!document) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '書類が見つかりません',
        },
      });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'ファイルが指定されていません',
        },
      });
      return;
    }

    // multer は originalname を latin1 として扱うため UTF-8 に戻す（日本語ファイル名対応）
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200);
    const fileKey = buildDocumentFileKey(document.id, originalName);

    await saveDocumentFile(fileKey, file.buffer);

    const previousKey = document.file_key;
    const updated = await prisma.document.update({
      where: { id },
      data: {
        file_key: fileKey,
        file_name: originalName,
        file_size: file.size,
        mime_type: file.mimetype,
      },
    });

    // 差し替え時は旧ファイルを削除（失敗してもアップロード自体は成功扱い）
    if (previousKey && previousKey !== fileKey) {
      try {
        await deleteDocumentFile(previousKey);
      } catch (cleanupError) {
        getRequestLogger().warn(
          { err: cleanupError, fileKey: previousKey },
          'Failed to delete previous document file'
        );
      }
    }

    res.status(200).json({
      success: true,
      data: {
        id: updated.id,
        fileName: updated.file_name,
        fileSize: updated.file_size,
        mimeType: updated.mime_type,
      },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error uploading document file');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'ファイルのアップロードに失敗しました',
      },
    });
  }
};

/**
 * ダウンロードURL取得
 * ローカル運用のためPre-signed URLではなく、認証付きのファイル配信
 * エンドポイント（GET /documents/:id/file）の相対URLを返す。
 */
export const getDocumentDownloadUrl = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;

    const document = await prisma.document.findFirst({
      where: { id, deleted_at: null },
    });

    if (!document) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '書類が見つかりません',
        },
      });
      return;
    }

    if (!document.file_key) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'アップロードされたファイルがありません',
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        url: `/api/v1/documents/${document.id}/file`,
        fileName: document.file_name,
        mimeType: document.mime_type,
        expiresIn: 0, // 認証付きエンドポイントのため有効期限なし
      },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error getting download URL');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'ダウンロードURLの取得に失敗しました',
      },
    });
  }
};

/**
 * 書類ファイル本体の配信（認証付きダウンロード）
 */
export const getDocumentFile = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;

    const document = await prisma.document.findFirst({
      where: { id, deleted_at: null },
    });

    if (!document || !document.file_key) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'ファイルが見つかりません',
        },
      });
      return;
    }

    let filePath: string;
    try {
      filePath = resolveDocumentFilePath(document.file_key);
    } catch {
      // file_key が不正（パストラバーサル等）の場合は404扱い
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'ファイルが見つかりません',
        },
      });
      return;
    }

    res.download(filePath, document.file_name || 'download', (err) => {
      if (err && !res.headersSent) {
        getRequestLogger().error(
          { err, fileKey: document.file_key },
          'Error sending document file'
        );
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'ファイルが見つかりません',
          },
        });
      }
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error downloading document file');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'ファイルのダウンロードに失敗しました',
      },
    });
  }
};
