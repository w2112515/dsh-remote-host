declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'

declare module 'qrcode/lib/browser.js' {
  interface DataUrlOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    margin?: number
    width?: number
  }

  const QRCode: {
    toDataURL(text: string, options?: DataUrlOptions): Promise<string>
  }
  export default QRCode
}
