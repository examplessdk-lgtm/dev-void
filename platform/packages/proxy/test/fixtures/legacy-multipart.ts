// SDK-generated MIME and its digest from before multipart header unfolding.
// Keep the digest fixed: a current-code calculation would hide upgrade regressions.
export const legacyMultipartDigest =
  '8409457699c7de52030141f0afbd3a8b9c30c7b25a9e0cc4c5392c207e40d0e5';
export const legacyMultipartMime = new TextEncoder().encode(
  [
    'Date: Sat, 10 Oct 2026 00:10:05 +0000',
    'From: acme+news@mail.example.com',
    'To: one@example.com',
    'Subject: upgrade retry',
    'Message-ID: <dcZR0jxv1siEy2Rs@mail.example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative;',
    ' boundary="=_void_alternative_1573725Jyj8yLCojOVRltQ"',
    '',
    '--=_void_alternative_1573725Jyj8yLCojOVRltQ',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    'Plain text',
    '--=_void_alternative_1573725Jyj8yLCojOVRltQ',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    '<p>HTML</p>',
    '--=_void_alternative_1573725Jyj8yLCojOVRltQ--',
    '',
  ].join('\r\n'),
);
