/** Whether an environment flag is set to something other than an explicit "off" value. */
export function envFlagEnabled(value ) {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && !["0", "false", "no", "off"].includes(normalized);
}
