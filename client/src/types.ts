export interface AccessRequest {
  id: number
  requestId: string
  requestorEmail: string
  expiresOn: string
  status: string
  revokedDt?: string | null
  revokedBy?: string | null
}
