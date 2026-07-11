// CSS module declarations for the SDK 57 template's web styles.
// (expo start generates equivalents into .expo/types; this keeps
// `tsc --noEmit` green in CI without a bundler run.)
declare module "*.module.css" {
  const styles: Record<string, string>;
  export default styles;
}
declare module "*.css";
