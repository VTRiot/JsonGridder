declare function diffSequence(
  aLength: number,
  bLength: number,
  isCommon: (aIndex: number, bIndex: number) => boolean,
  foundSubsequence: (nCommon: number, aCommon: number, bCommon: number) => void
): void

export default diffSequence
