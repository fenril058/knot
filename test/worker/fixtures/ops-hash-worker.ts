import { opsHash } from '../../../src/storage/hash.ts';

export default {
  fetch(): Response {
    return Response.json({
      digest: opsHash('p', 0, [{ type: 'insert', id: 'l1', after: '_head', text: 'T' }]),
      runtime: 'workerd',
    });
  },
};
