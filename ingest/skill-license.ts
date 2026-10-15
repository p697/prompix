/** Accept the complete standard MIT grant, not keyword matches or a license label alone. */
export function standardMITGrant(text: string): boolean {
  const marker = "Permission is hereby granted, free of charge";
  const start = text.indexOf(marker); if (start < 0) return false;
  const prefix = text.slice(0, start).trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!prefix.length || prefix.some(line => !/^(?:(?:The )?MIT License(?: \(MIT\))?|Copyright(?: \(c\)| ©)? .+)$/.test(line))) return false;
  const expected = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
  return normalize(text.slice(start)) === normalize(expected);
}
