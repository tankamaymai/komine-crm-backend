/**
 * 区画図のマスの場所: 入力チェックと API
 */
import { Request, Response } from 'express';

import { plotMapPositionsBodySchema } from '../../src/validations/plotMapValidation';
import { getPlotMap } from '../../src/plots/controllers/getPlotMap';
import { putPlotMapPositions } from '../../src/plots/controllers/putPlotMapPositions';
import * as plotMapService from '../../src/plots/services/plotMapService';
import * as positionService from '../../src/plots/services/plotMapPositionService';

jest.mock('../../src/db/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/plots/services/plotMapService');
jest.mock('../../src/plots/services/plotMapPositionService');

const position = { originRow: 1, originCol: 4, plotLabel: '12', row: 3, col: 5 };

function buildResponse() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

describe('plotMapPositionsBodySchema', () => {
  it('正しい入力を通す', () => {
    const result = plotMapPositionsBodySchema.safeParse({ mapId: '1-A', positions: [position] });
    expect(result.success).toBe(true);
  });

  it('知らない区画図は通さない', () => {
    const result = plotMapPositionsBodySchema.safeParse({ mapId: 'nope', positions: [] });
    expect(result.success).toBe(false);
  });

  it('マイナスや小数の行・列は通さない', () => {
    expect(
      plotMapPositionsBodySchema.safeParse({ mapId: '1-A', positions: [{ ...position, row: -1 }] })
        .success
    ).toBe(false);
    expect(
      plotMapPositionsBodySchema.safeParse({ mapId: '1-A', positions: [{ ...position, col: 1.5 }] })
        .success
    ).toBe(false);
  });

  it('同じ元のマスが二つあれば通さない', () => {
    const result = plotMapPositionsBodySchema.safeParse({
      mapId: '1-A',
      positions: [position, { ...position, row: 6 }],
    });
    expect(result.success).toBe(false);
  });

  it('同じ移動先が二つあれば通さない', () => {
    const result = plotMapPositionsBodySchema.safeParse({
      mapId: '1-A',
      positions: [position, { ...position, originRow: 2 }],
    });
    expect(result.success).toBe(false);
  });
});

describe('getPlotMap', () => {
  it('契約の重ね合わせと、保存済みのマスの場所を返す', async () => {
    jest.mocked(plotMapService.getPlotMapOverlays).mockResolvedValue([]);
    jest.mocked(positionService.getPlotMapPositions).mockResolvedValue([position]);
    const { res, status, json } = buildResponse();

    await getPlotMap({ query: { mapId: '1-A' } } as unknown as Request, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      success: true,
      data: { mapId: '1-A', plots: [], positions: [position] },
    });
  });
});

describe('putPlotMapPositions', () => {
  it('保存して、保存後の場所を返す', async () => {
    jest.mocked(positionService.replacePlotMapPositions).mockResolvedValue([position]);
    const { res, status, json } = buildResponse();
    const req = {
      body: { mapId: '1-A', positions: [position] },
      user: { id: 7 },
    } as unknown as Request;

    await putPlotMapPositions(req, res);

    expect(positionService.replacePlotMapPositions).toHaveBeenCalledWith(expect.anything(), {
      mapId: '1-A',
      positions: [position],
      staffId: 7,
    });
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      success: true,
      data: { mapId: '1-A', positions: [position] },
    });
  });

  it('保存に失敗したら 500 を返す', async () => {
    jest.mocked(positionService.replacePlotMapPositions).mockRejectedValue(new Error('db down'));
    const { res, status, json } = buildResponse();
    const req = { body: { mapId: '1-A', positions: [] } } as unknown as Request;

    await putPlotMapPositions(req, res);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ message: '区画図の保存に失敗しました' }),
      })
    );
  });
});
