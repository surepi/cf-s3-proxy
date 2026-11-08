// AWS 官方文档 "GET Object" 示例向量
import { signS3Request } from '../src/sigv4.js';
const h = new Headers({ range: 'bytes=0-9' });
await signS3Request({
  method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: h,
  region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  now: new Date('2013-05-24T00:00:00Z'),
});
const want = 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41';
const got = h.get('authorization').match(/Signature=(\w+)/)[1];
console.log(got === want ? 'PASS' : `FAIL got ${got}`);
process.exit(got === want ? 0 : 1);
