import {
  plotSearchQuerySchema,
  plotIdParamsSchema,
  createPlotSchema,
  updatePlotSchema,
  createPlotContractSchema,
  familyContactSchema,
  changeContractorSchema,
} from '../../src/validations/plotValidation';

describe('Plot Validation (ContractPlot Model)', () => {
  describe('plotSearchQuerySchema', () => {
    it('有効な検索クエリでバリデーションが成功すること', () => {
      const validData = {
        page: '1',
        limit: '20',
        search: 'A-01',
        usageStatus: 'available',
        cemeteryType: 'general',
      };

      const result = plotSearchQuerySchema.parse(validData);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.search).toBe('A-01');
    });

    it('パラメータが未指定の場合デフォルト値が設定されること', () => {
      const result = plotSearchQuerySchema.parse({});
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('オプションパラメータが省略可能であること', () => {
      const validData = {
        page: '2',
        limit: '50',
      };

      const result = plotSearchQuerySchema.parse(validData);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(50);
    });

    it('contractStatus に active / terminated を指定できること（#200）', () => {
      expect(plotSearchQuerySchema.parse({ contractStatus: 'active' }).contractStatus).toBe(
        'active'
      );
      expect(plotSearchQuerySchema.parse({ contractStatus: 'terminated' }).contractStatus).toBe(
        'terminated'
      );
    });

    it('contractStatus に vacant は指定できないこと（台帳問い合わせは vacant 非表示 #167）', () => {
      expect(() => plotSearchQuerySchema.parse({ contractStatus: 'vacant' })).toThrow();
    });

    it('occupancy に in_use / vacant / all を指定できること', () => {
      expect(plotSearchQuerySchema.parse({ occupancy: 'in_use' }).occupancy).toBe('in_use');
      expect(plotSearchQuerySchema.parse({ occupancy: 'vacant' }).occupancy).toBe('vacant');
      expect(plotSearchQuerySchema.parse({ occupancy: 'all' }).occupancy).toBe('all');
    });
  });

  describe('plotIdParamsSchema', () => {
    it('有効なUUID形式のIDでバリデーションが成功すること', () => {
      const validData = {
        id: '123e4567-e89b-12d3-a456-426614174000',
      };

      expect(() => plotIdParamsSchema.parse(validData)).not.toThrow();
    });

    it('無効なUUID形式でエラーが発生すること', () => {
      const invalidData = {
        id: 'invalid-uuid',
      };

      expect(() => plotIdParamsSchema.parse(invalidData)).toThrow();
    });

    it('IDが欠けている場合エラーが発生すること', () => {
      expect(() => plotIdParamsSchema.parse({})).toThrow();
    });
  });

  describe('createPlotSchema', () => {
    const validCreatePlotData = {
      physicalPlot: {
        plotNumber: 'A-01',
        areaName: '一般墓地A',
        areaSqm: 3.6,
        notes: '',
      },
      contractPlot: {
        contractAreaSqm: 3.6,
        saleStatus: 'completed',
        locationDescription: '南側',
      },
      saleContract: {
        contractDate: '2024-01-01',
        price: 1000000,
        paymentStatus: 'paid',
        customerRole: 'applicant',
        reservationDate: '2023-12-15',
        acceptanceNumber: 'ACC-2024-001',
        permitDate: '2024-01-05',
        startDate: '2024-01-10',
        notes: '',
      },
      customer: {
        name: '山田太郎',
        nameKana: 'ヤマダタロウ',
        birthDate: '1980-01-01',
        gender: 'male',
        postalCode: '1500001',
        address: '東京都渋谷区',
        registeredAddress: '東京都渋谷区',
        phoneNumber: '0312345678',
        faxNumber: '',
        email: 'test@example.com',
        notes: '',
      },
    };

    it('有効な区画データでバリデーションが成功すること', () => {
      expect(() => createPlotSchema.parse(validCreatePlotData)).not.toThrow();
    });

    it('physicalPlotが必須であること', () => {
      const { physicalPlot, ...dataWithoutPhysicalPlot } = validCreatePlotData;
      expect(() => createPlotSchema.parse(dataWithoutPhysicalPlot)).toThrow();
    });

    it('contractPlotが必須であること', () => {
      const { contractPlot, ...dataWithoutContractPlot } = validCreatePlotData;
      expect(() => createPlotSchema.parse(dataWithoutContractPlot)).toThrow();
    });

    it('saleContractが必須であること', () => {
      const { saleContract, ...dataWithoutSaleContract } = validCreatePlotData;
      expect(() => createPlotSchema.parse(dataWithoutSaleContract)).toThrow();
    });

    it('customerが必須であること', () => {
      const { customer, ...dataWithoutCustomer } = validCreatePlotData;
      expect(() => createPlotSchema.parse(dataWithoutCustomer)).toThrow();
    });

    it('区画番号が50文字を超える場合エラーが発生すること', () => {
      const invalidData = {
        ...validCreatePlotData,
        physicalPlot: {
          ...validCreatePlotData.physicalPlot,
          plotNumber: 'A'.repeat(51),
        },
      };
      expect(() => createPlotSchema.parse(invalidData)).toThrow();
    });

    it('区画番号が大文字英数字とハイフンのみ使用できること', () => {
      // 有効なパターン
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          physicalPlot: { ...validCreatePlotData.physicalPlot, plotNumber: 'A-001' },
        })
      ).not.toThrow();
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          physicalPlot: { ...validCreatePlotData.physicalPlot, plotNumber: 'ABC123' },
        })
      ).not.toThrow();

      // 無効なパターン（小文字）
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          physicalPlot: { ...validCreatePlotData.physicalPlot, plotNumber: 'a-001' },
        })
      ).toThrow();

      // 無効なパターン（アンダースコア）
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          physicalPlot: { ...validCreatePlotData.physicalPlot, plotNumber: 'A_001' },
        })
      ).toThrow();
    });

    it('区域名が100文字を超える場合エラーが発生すること', () => {
      const invalidData = {
        ...validCreatePlotData,
        physicalPlot: {
          ...validCreatePlotData.physicalPlot,
          areaName: 'あ'.repeat(101),
        },
      };
      expect(() => createPlotSchema.parse(invalidData)).toThrow();
    });

    it('面積が正の数値であること', () => {
      // 有効なパターン
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          physicalPlot: { ...validCreatePlotData.physicalPlot, areaSqm: 3.6 },
        })
      ).not.toThrow();

      // 無効なパターン（負の数）
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          physicalPlot: { ...validCreatePlotData.physicalPlot, areaSqm: -1 },
        })
      ).toThrow();

      // 無効なパターン（ゼロ）
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          physicalPlot: { ...validCreatePlotData.physicalPlot, areaSqm: 0 },
        })
      ).toThrow();
    });

    it('契約面積が正の数値であること', () => {
      // 有効なパターン
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          contractPlot: { ...validCreatePlotData.contractPlot, contractAreaSqm: 3.6 },
        })
      ).not.toThrow();

      // 無効なパターン
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          contractPlot: { ...validCreatePlotData.contractPlot, contractAreaSqm: -1 },
        })
      ).toThrow();
    });

    it('顧客名が必須であること', () => {
      const invalidData = {
        ...validCreatePlotData,
        customer: {
          ...validCreatePlotData.customer,
          name: '',
        },
      };
      expect(() => createPlotSchema.parse(invalidData)).toThrow();
    });

    it('顧客名が100文字以内であること', () => {
      const invalidData = {
        ...validCreatePlotData,
        customer: {
          ...validCreatePlotData.customer,
          name: 'あ'.repeat(101),
        },
      };
      expect(() => createPlotSchema.parse(invalidData)).toThrow();
    });

    it('顧客名カナがカタカナであること', () => {
      // 有効なパターン
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          customer: { ...validCreatePlotData.customer, nameKana: 'ヤマダタロウ' },
        })
      ).not.toThrow();

      // 無効なパターン（ひらがな）
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          customer: { ...validCreatePlotData.customer, nameKana: 'やまだたろう' },
        })
      ).toThrow();
    });

    it('郵便番号が必須であること', () => {
      const invalidData = {
        ...validCreatePlotData,
        customer: {
          ...validCreatePlotData.customer,
          postalCode: '',
        },
      };
      expect(() => createPlotSchema.parse(invalidData)).toThrow();
    });

    it('住所が必須であること', () => {
      const invalidData = {
        ...validCreatePlotData,
        customer: {
          ...validCreatePlotData.customer,
          address: '',
        },
      };
      expect(() => createPlotSchema.parse(invalidData)).toThrow();
    });

    it('契約日は省略可能であること（レガシーDBで45%空のため nullable 化）', () => {
      const dataWithoutContractDate = {
        ...validCreatePlotData,
        saleContract: {
          ...validCreatePlotData.saleContract,
          contractDate: undefined,
        },
      };
      expect(() => createPlotSchema.parse(dataWithoutContractDate)).not.toThrow();
    });

    it('価格が0以上の数値であること', () => {
      // 有効なパターン（0円）
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          saleContract: { ...validCreatePlotData.saleContract, price: 0 },
        })
      ).not.toThrow();

      // 無効なパターン（負の数）
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          saleContract: { ...validCreatePlotData.saleContract, price: -1 },
        })
      ).toThrow();
    });

    it('WorkInfo情報が有効であること（オプション）', () => {
      const dataWithWorkInfo = {
        ...validCreatePlotData,
        workInfo: {
          workPostalCode: '1500001',
          workAddress: '東京都渋谷区',
          workPhoneNumber: '0312345678',
          workFaxNumber: '',
        },
      };

      expect(() => createPlotSchema.parse(dataWithWorkInfo)).not.toThrow();
    });

    // #393: workInfo.dmSetting / addressType は Prisma enum 列。任意文字列（空文字含む）を
    // 受理して 500（tx ロールバック）になっていた。nativeEnum で弾く。
    it('workInfo.dmSetting に enum 外の文字列を渡すと拒否されること（#393）', () => {
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          workInfo: { dmSetting: 'foo' },
        })
      ).toThrow();
    });

    it('workInfo.addressType に enum 外の文字列を渡すと拒否されること（#393）', () => {
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          workInfo: { addressType: 'bar' },
        })
      ).toThrow();
    });

    it('workInfo.dmSetting / addressType の有効な enum 値は受理されること（#393）', () => {
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          workInfo: { dmSetting: 'allow', addressType: 'home' },
        })
      ).not.toThrow();
    });

    it('workInfo.dmSetting / addressType の空文字は undefined 化されて受理されること（#393）', () => {
      const parsed = createPlotSchema.parse({
        ...validCreatePlotData,
        workInfo: { dmSetting: '', addressType: '' },
      });
      expect(parsed.workInfo?.dmSetting).toBeUndefined();
      expect(parsed.workInfo?.addressType).toBeUndefined();
    });

    // #395: workInfo.workPostalCode は DB VarChar(7)。8〜10 文字は zod max(10) を通過して
    // P2000 → 500 になっていた。max(7) に縮小。
    it('workInfo.workPostalCode が 8 文字以上だと拒否されること（#395）', () => {
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          workInfo: { workPostalCode: '12345678' }, // 8文字
        })
      ).toThrow();
    });

    it('workInfo.workPostalCode が 7 文字なら受理されること（#395）', () => {
      expect(() =>
        createPlotSchema.parse({
          ...validCreatePlotData,
          workInfo: { workPostalCode: '1234567' }, // 7文字
        })
      ).not.toThrow();
    });

    it('BillingInfo情報が有効であること（オプション）', () => {
      const dataWithBillingInfo = {
        ...validCreatePlotData,
        billingInfo: {
          billingType: 'bank_transfer',
          accountType: 'savings',
          bankName: 'みずほ銀行',
          branchName: '渋谷支店',
          accountNumber: '1234567',
          accountHolder: 'ヤマダタロウ',
        },
      };

      expect(() => createPlotSchema.parse(dataWithBillingInfo)).not.toThrow();
    });

    it('UsageFee情報が有効であること（オプション）', () => {
      const dataWithUsageFee = {
        ...validCreatePlotData,
        usageFee: {
          calculationType: 'area',
          taxType: 'included',
          billingType: 'annual',
          billingYears: '10',
          area: '3.6',
          unitPrice: '100000',
          usageFee: '360000',
          paymentMethod: 'bank_transfer',
        },
      };

      expect(() => createPlotSchema.parse(dataWithUsageFee)).not.toThrow();
    });

    it('ManagementFee情報が有効であること（オプション）', () => {
      const dataWithManagementFee = {
        ...validCreatePlotData,
        managementFee: {
          calculationType: 'area',
          taxType: 'included',
          billingType: 'annual',
          billingYears: '1',
          area: '3.6',
          billingMonth: '4',
          managementFee: '5000',
          unitPrice: '1500',
          lastBillingMonth: '2024年3月',
          paymentMethod: 'bank_transfer',
        },
      };

      expect(() => createPlotSchema.parse(dataWithManagementFee)).not.toThrow();
    });

    // #320: applicant / gravestoneInfo が Zod により黙って strip されていた問題の回帰テスト
    it('applicant が parse 結果に保持されること（#320）', () => {
      const data = {
        ...validCreatePlotData,
        applicant: { name: '山田花子', nameKana: 'ヤマダハナコ' },
      };
      const parsed = createPlotSchema.parse(data);
      expect(parsed.applicant).toMatchObject({ name: '山田花子', nameKana: 'ヤマダハナコ' });
    });

    it('gravestoneInfo が parse 結果に保持されること（#320）', () => {
      const data = {
        ...validCreatePlotData,
        gravestoneInfo: { gravestoneDealer: '〇〇石材', gravestoneType: '和型' },
      };
      const parsed = createPlotSchema.parse(data);
      expect(parsed.gravestoneInfo).toMatchObject({ gravestoneDealer: '〇〇石材' });
    });

    // #384: createPlotSchema に buriedPersons が無く、validate ミドルウェアが
    // 未知キーとして strip → createPlot の保存処理に届かず破棄されていた回帰テスト（#320 同型）
    it('buriedPersons が parse 結果に保持されること（#384）', () => {
      const data = {
        ...validCreatePlotData,
        buriedPersons: [
          {
            name: '山田一郎',
            nameKana: 'ヤマダイチロウ',
            relationship: '父',
            deathPlace: '東京都病院',
            causeOfDeath: '老衰',
          },
        ],
      };
      const parsed = createPlotSchema.parse(data) as typeof data;
      expect(parsed.buriedPersons).toHaveLength(1);
      expect(parsed.buriedPersons[0]).toMatchObject({
        name: '山田一郎',
        deathPlace: '東京都病院',
        causeOfDeath: '老衰',
      });
    });
  });

  describe('updatePlotSchema', () => {
    it('有効な更新データでバリデーションが成功すること', () => {
      const validData = {
        contractPlot: {
          saleStatus: 'completed',
        },
        saleContract: {
          paymentStatus: 'paid',
        },
      };

      expect(() => updatePlotSchema.parse(validData)).not.toThrow();
    });

    it('全フィールドがオプションであること', () => {
      expect(() => updatePlotSchema.parse({})).not.toThrow();
    });

    it('contractPlotのみ更新可能であること', () => {
      const validData = {
        contractPlot: {
          saleStatus: 'pending',
          locationDescription: '北側に変更',
        },
      };

      expect(() => updatePlotSchema.parse(validData)).not.toThrow();
    });

    it('saleContractのみ更新可能であること', () => {
      const validData = {
        saleContract: {
          paymentStatus: 'partial',
          notes: '分割払い',
        },
      };

      expect(() => updatePlotSchema.parse(validData)).not.toThrow();
    });

    it('customerのみ更新可能であること', () => {
      const validData = {
        customer: {
          phoneNumber: '09012345678',
          email: 'updated@example.com',
        },
      };

      expect(() => updatePlotSchema.parse(validData)).not.toThrow();
    });

    it('複数セクション同時更新が可能であること', () => {
      const validData = {
        contractPlot: {
          saleStatus: 'completed',
        },
        saleContract: {
          paymentStatus: 'paid',
        },
        customer: {
          address: '東京都新宿区',
        },
      };

      expect(() => updatePlotSchema.parse(validData)).not.toThrow();
    });

    it('部分的なcustomer情報更新が可能であること', () => {
      const partialCustomer = {
        customer: {
          phoneNumber: '09099998888',
        },
      };

      expect(() => updatePlotSchema.parse(partialCustomer)).not.toThrow();
    });

    it('WorkInfo更新が可能であること', () => {
      const validData = {
        workInfo: {
          workAddress: '東京都千代田区',
          workPhoneNumber: '0399998888',
        },
      };

      expect(() => updatePlotSchema.parse(validData)).not.toThrow();
    });

    it('BillingInfo更新が可能であること', () => {
      const validData = {
        billingInfo: {
          bankName: '三菱UFJ銀行',
          branchName: '新宿支店',
        },
      };

      expect(() => updatePlotSchema.parse(validData)).not.toThrow();
    });

    it('UsageFee更新が可能であること', () => {
      const validData = {
        usageFee: {
          paymentMethod: 'credit_card',
        },
      };

      expect(() => updatePlotSchema.parse(validData)).not.toThrow();
    });

    // フロントが各フィールドを null として送信するため null 許容が必須
    it('UsageFee の各フィールドが null を受け入れること', () => {
      const data = {
        usageFee: {
          calculationType: null,
          taxType: null,
          billingType: null,
          billingYears: null,
          area: null,
          unitPrice: null,
          usageFee: null,
          paymentMethod: null,
        },
      };
      expect(() => updatePlotSchema.parse(data)).not.toThrow();
    });

    it('ManagementFee の各フィールドが null を受け入れること', () => {
      const data = {
        managementFee: {
          calculationType: null,
          taxType: null,
          billingType: null,
          billingYears: null,
          area: null,
          billingMonth: null,
          managementFee: null,
          unitPrice: null,
          lastBillingMonth: null,
          paymentMethod: null,
        },
      };
      expect(() => updatePlotSchema.parse(data)).not.toThrow();
    });

    it('ManagementFee更新が可能であること', () => {
      const validData = {
        managementFee: {
          lastBillingMonth: '2024年12月',
        },
      };

      expect(() => updatePlotSchema.parse(validData)).not.toThrow();
    });

    // issue #62: physicalPlot / constructionInfos が Zod により黙ってstripされていた問題の回帰テスト
    describe('physicalPlot 更新（issue #62）', () => {
      it('physicalPlot.notes のみ更新が可能であること', () => {
        const data = { physicalPlot: { notes: '備考メモ' } };
        const parsed = updatePlotSchema.parse(data);
        expect(parsed.physicalPlot?.notes).toBe('備考メモ');
      });

      it('physicalPlot の全フィールド更新が可能であること', () => {
        const data = {
          physicalPlot: {
            plotNumber: 'A-100',
            areaName: '北区域',
            areaSqm: 3.6,
            status: 'available',
            notes: 'メモ',
          },
        };
        const parsed = updatePlotSchema.parse(data);
        expect(parsed.physicalPlot).toEqual(data.physicalPlot);
      });

      it('physicalPlot.areaSqm に文字列を渡すとバリデーションエラーになること', () => {
        const data = { physicalPlot: { areaSqm: 'invalid' as unknown as number } };
        expect(() => updatePlotSchema.parse(data)).toThrow();
      });

      it('physicalPlot.notes に null を許容すること', () => {
        const data = { physicalPlot: { notes: null } };
        expect(() => updatePlotSchema.parse(data)).not.toThrow();
      });
    });

    describe('constructionInfos 更新（issue #62）', () => {
      it('constructionInfos の配列が parse 結果に保持されること', () => {
        const data = {
          constructionInfos: [
            {
              id: '550e8400-e29b-41d4-a716-446655440000',
              constructionType: '建立',
              contractor: '〇〇石材',
              notes: '工事メモ',
            },
          ],
        };
        const parsed = updatePlotSchema.parse(data);
        expect(parsed.constructionInfos).toHaveLength(1);
        expect(parsed.constructionInfos?.[0].id).toBe('550e8400-e29b-41d4-a716-446655440000');
        expect(parsed.constructionInfos?.[0].notes).toBe('工事メモ');
      });

      it('id 無しの新規工事情報も受け入れること', () => {
        const data = {
          constructionInfos: [{ contractor: '新規業者' }],
        };
        const parsed = updatePlotSchema.parse(data);
        expect(parsed.constructionInfos?.[0].contractor).toBe('新規業者');
      });

      it('空配列も許容すること', () => {
        const data = { constructionInfos: [] };
        expect(() => updatePlotSchema.parse(data)).not.toThrow();
      });
    });

    // #261: 変更理由の受理
    describe('changeReason（#261）', () => {
      it('changeReason を受理し parse 結果に保持すること', () => {
        const parsed = updatePlotSchema.parse({ changeReason: '名義変更' });
        expect(parsed.changeReason).toBe('名義変更');
      });

      it('changeReason 省略時は undefined のまま通過すること', () => {
        const parsed = updatePlotSchema.parse({});
        expect(parsed.changeReason).toBeUndefined();
      });

      it('changeReason が 200 文字を超えるとバリデーションエラーになること', () => {
        expect(() => updatePlotSchema.parse({ changeReason: 'あ'.repeat(201) })).toThrow();
      });
    });

    // #320: applicant / gravestoneInfo / workInfo ネストキーが Zod により黙って strip されていた問題の回帰テスト
    // （#62 の physicalPlot / constructionInfos と同種）
    describe('applicant / gravestoneInfo / workInfo の strip 回帰（#320）', () => {
      it('applicant が parse 結果に保持されること', () => {
        const data = {
          applicant: { name: '山田花子', nameKana: 'ヤマダハナコ', phoneNumber: '09012345678' },
        };
        const parsed = updatePlotSchema.parse(data);
        expect(parsed.applicant).toMatchObject({ name: '山田花子', nameKana: 'ヤマダハナコ' });
      });

      it('applicant の部分更新（name 無し）も受理すること', () => {
        const parsed = updatePlotSchema.parse({ applicant: { phoneNumber: '09012345678' } });
        expect(parsed.applicant).toMatchObject({ phoneNumber: '09012345678' });
      });

      it('applicant: null（既存 applicant の解除）を受理すること', () => {
        const parsed = updatePlotSchema.parse({ applicant: null });
        expect(parsed.applicant).toBeNull();
      });

      it('gravestoneInfo が parse 結果に保持されること', () => {
        const data = {
          gravestoneInfo: { gravestoneDealer: '〇〇石材', gravestoneType: '和型' },
        };
        const parsed = updatePlotSchema.parse(data);
        expect(parsed.gravestoneInfo).toMatchObject({ gravestoneDealer: '〇〇石材' });
      });

      it('gravestoneInfo: null（削除）を受理すること', () => {
        const parsed = updatePlotSchema.parse({ gravestoneInfo: null });
        expect(parsed.gravestoneInfo).toBeNull();
      });

      it('workInfo の companyName / dmSetting 等が strip されないこと', () => {
        const data = {
          workInfo: {
            companyName: '株式会社テスト',
            companyNameKana: 'カブシキガイシャテスト',
            workAddress: '東京都港区',
            dmSetting: 'allow',
            addressType: 'work',
            notes: '勤務先メモ',
          },
        };
        const parsed = updatePlotSchema.parse(data);
        expect(parsed.workInfo).toMatchObject({
          companyName: '株式会社テスト',
          dmSetting: 'allow',
          addressType: 'work',
          notes: '勤務先メモ',
        });
      });

      it('workInfo の companyName が 100 文字を超えるとバリデーションエラーになること', () => {
        expect(() =>
          updatePlotSchema.parse({ workInfo: { companyName: 'あ'.repeat(101) } })
        ).toThrow();
      });
    });
  });

  describe('createPlotContractSchema', () => {
    const validContractData = {
      contractPlot: {
        contractAreaSqm: 1.8,
        saleStatus: 'completed',
        locationDescription: '東側',
      },
      saleContract: {
        contractDate: '2024-06-01',
        price: 500000,
        paymentStatus: 'paid',
        customerRole: 'contractor',
      },
      customer: {
        name: '田中花子',
        nameKana: 'タナカハナコ',
        postalCode: '1500002',
        address: '東京都渋谷区',
        phoneNumber: '09012345678',
        faxNumber: '',
      },
    };

    it('有効な契約データでバリデーションが成功すること', () => {
      expect(() => createPlotContractSchema.parse(validContractData)).not.toThrow();
    });

    it('physicalPlotフィールドは不要であること', () => {
      // physicalPlotがなくてもエラーにならない
      expect(() => createPlotContractSchema.parse(validContractData)).not.toThrow();
    });

    it('contractPlotが必須であること', () => {
      const { contractPlot, ...dataWithoutContractPlot } = validContractData;
      expect(() => createPlotContractSchema.parse(dataWithoutContractPlot)).toThrow();
    });

    it('saleContractが必須であること', () => {
      const { saleContract, ...dataWithoutSaleContract } = validContractData;
      expect(() => createPlotContractSchema.parse(dataWithoutSaleContract)).toThrow();
    });

    it('customerが必須であること', () => {
      const { customer, ...dataWithoutCustomer } = validContractData;
      expect(() => createPlotContractSchema.parse(dataWithoutCustomer)).toThrow();
    });

    it('オプションフィールドが有効であること', () => {
      const dataWithOptionalFields = {
        ...validContractData,
        workInfo: {
          workAddress: '東京都港区',
          workPhoneNumber: '0355556666',
        },
        billingInfo: {
          accountType: 'checking',
          bankName: 'りそな銀行',
        },
        usageFee: {
          usageFee: '200000',
        },
        managementFee: {
          managementFee: '3000',
        },
      };

      expect(() => createPlotContractSchema.parse(dataWithOptionalFields)).not.toThrow();
    });
  });

  describe('familyContactSchema の DB カラム長整合 (#276)', () => {
    const base = { name: '山田太郎', relationship: '長男' };

    it('DB VarChar 長以内の値は通過する', () => {
      expect(() =>
        familyContactSchema.parse({
          ...base,
          phoneNumber: '09012345678', // 11文字 = VarChar(11)
          faxNumber: '0951234567', // 10文字
          postalCode: '8500000', // 7文字 = VarChar(7)
          phoneNumber2: '095-123-4567', // 12文字 <= VarChar(15)
          workPhoneNumber: '095-123-4567',
        })
      ).not.toThrow();
    });

    it('電話番号が VarChar(11) を超えると Zod で弾く（P2000 の 500 を防ぐ）', () => {
      // 修正前: max(20) で '090-1234-5678'(13文字) が Zod を通過し Prisma P2000 → 500
      expect(() => familyContactSchema.parse({ ...base, phoneNumber: '090-1234-5678' })).toThrow(
        /11文字以内/
      );
    });

    it('郵便番号が VarChar(7) を超えると Zod で弾く', () => {
      expect(() => familyContactSchema.parse({ ...base, postalCode: '850-0000' })).toThrow(
        /7文字以内/
      );
    });

    it('FAX番号が VarChar(11) を超えると Zod で弾く', () => {
      expect(() => familyContactSchema.parse({ ...base, faxNumber: '095-123-45678' })).toThrow(
        /11文字以内/
      );
    });

    it('空文字・未指定は従来どおり許容する（バルク登録のスキップ判定と整合）', () => {
      expect(() =>
        familyContactSchema.parse({ ...base, phoneNumber: '', postalCode: '', faxNumber: '' })
      ).not.toThrow();
      expect(() => familyContactSchema.parse(base)).not.toThrow();
    });
  });

  describe('changeContractorSchema (#310)', () => {
    const validNewCustomer = {
      name: '鈴木三郎',
      nameKana: 'スズキサブロウ',
      postalCode: '8100001',
      address: '福岡県福岡市中央区天神1-1-1',
      phoneNumber: '09011112222',
    };

    it('newCustomerId のみの指定は有効', () => {
      expect(() =>
        changeContractorSchema.parse({
          newCustomerId: '550e8400-e29b-41d4-a716-446655440000',
        })
      ).not.toThrow();
    });

    it('newCustomer のみの指定は有効（changeDate / reason は任意）', () => {
      expect(() =>
        changeContractorSchema.parse({
          newCustomer: validNewCustomer,
          changeDate: '2026-06-01',
          reason: '相続のため',
        })
      ).not.toThrow();
    });

    it('newCustomerId と newCustomer の同時指定は拒否（排他）', () => {
      expect(() =>
        changeContractorSchema.parse({
          newCustomerId: '550e8400-e29b-41d4-a716-446655440000',
          newCustomer: validNewCustomer,
        })
      ).toThrow(/どちらか一方/);
    });

    it('どちらも未指定は拒否', () => {
      expect(() => changeContractorSchema.parse({})).toThrow(/どちらか一方/);
    });

    it('理由が200文字を超えると拒否', () => {
      expect(() =>
        changeContractorSchema.parse({
          newCustomerId: '550e8400-e29b-41d4-a716-446655440000',
          reason: 'あ'.repeat(201),
        })
      ).toThrow(/200文字以内/);
    });
  });
});
