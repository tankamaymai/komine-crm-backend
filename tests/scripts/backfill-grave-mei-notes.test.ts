import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadGraveMeiFromDump } from '../../scripts/backfill-grave-mei-notes';

describe('loadGraveMeiFromDump', () => {
  it('m_bochi の grave_mei を grave_cd マップとして読む', () => {
    const dump = `
CREATE TABLE \`m_bochi\` (
  \`grave_cd\` int(8) NOT NULL,
  \`grave_mei\` text,
  \`note\` text,
  PRIMARY KEY (\`grave_cd\`)
) ENGINE=InnoDB;

INSERT INTO \`m_bochi\` VALUES (21,'期限付き解約者',NULL),(22,'',NULL),(23,NULL,'備考だけ');\r
`;
    const file = path.join(os.tmpdir(), `grave-mei-dump-${Date.now()}.sql`);
    fs.writeFileSync(file, dump, 'utf8');
    try {
      const map = loadGraveMeiFromDump(file);
      expect(map.get(21)).toBe('期限付き解約者');
      expect(map.has(22)).toBe(false);
      expect(map.has(23)).toBe(false);
    } finally {
      fs.unlinkSync(file);
    }
  });
});
