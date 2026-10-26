// Monaco's language definitions ship without types; the editor reads only their configuration.
declare module "monaco-editor/languages/definitions/*" {
  export const conf: import("monaco-editor/editor/editor.api").languages.LanguageConfiguration;
}
