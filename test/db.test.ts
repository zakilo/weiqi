import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteGame, getGame, listGames, saveGame } from '../src/store/db';

const SGF_A = '(;GM[1]SZ[19];B[aa];W[bb])';
const SGF_B = '(;GM[1]SZ[19];B[cc];W[dd];B[ee])';

beforeEach(async () => {
  indexedDB = new IDBFactory();
});

describe('IndexedDB 棋谱库', () => {
  it('保存后可列出与读取,按时间倒序', async () => {
    const idA = await saveGame({ name: '对局A', sgfText: SGF_A, moveCount: 2, createdAt: 1000 });
    const idB = await saveGame({ name: '对局B', sgfText: SGF_B, moveCount: 3, createdAt: 2000 });

    const rows = await listGames();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: idB, name: '对局B', moveCount: 3 });
    expect(rows[1]).toMatchObject({ id: idA, name: '对局A' });

    const rec = await getGame(idA);
    expect(rec?.sgfText).toBe(SGF_A);
  });

  it('删除后不再列出,读取返回 undefined', async () => {
    const id = await saveGame({ name: '待删', sgfText: SGF_A, moveCount: 2, createdAt: 1 });
    await deleteGame(id);
    expect(await listGames()).toHaveLength(0);
    expect(await getGame(id)).toBeUndefined();
  });

  it('自增 id 不重复', async () => {
    const id1 = await saveGame({ name: '1', sgfText: SGF_A, moveCount: 1, createdAt: 1 });
    const id2 = await saveGame({ name: '2', sgfText: SGF_A, moveCount: 1, createdAt: 2 });
    expect(id2).not.toBe(id1);
  });
});
