export interface Policy {
  imageOrigins: string[]
  linkOrigins: string[]
}
export function validateManifest(
  manifest: unknown,
  policy: Policy,
): { ok: boolean; app: string | null; generated_at: string | null; tiles: Array<{ id: string }>; errors: Array<{ id: string | null; message: string }> }
