/**
 * PortValue：连线上流动的值的统一封装。
 * 形态与 Object Type 的 kind 对应：text / json / file。
 */
export const MAX_FILE_INPUT_BYTES = 32 * 1024 * 1024;

export type PortValue =
  | { kind: "text"; text: string }
  | { kind: "json"; json: unknown }
  | {
      kind: "file";
      file: {
        /** 相对 data/ 目录的存储路径 */
        path: string;
        name: string;
        mime: string;
        /**
         * 输入节点按对象类型完成的 PDF 预处理结果。路径仍相对 data/；客户端提交的
         * 同名字段不受信，运行物化时会重建。
         */
        preprocessed?: {
          kind: "pdf";
          pageCount: number;
          textPath: string;
          pageImagePaths: string[];
        };
      };
    };

export function portValueToDisplay(v: PortValue): string {
  switch (v.kind) {
    case "text":
      return v.text;
    case "json":
      return JSON.stringify(v.json, null, 2);
    case "file":
      return `[文件] ${v.file.name}`;
  }
}

/** 注入 prompt 占位符时的文本化（file 在引擎层单独作为附件处理） */
export function portValueToPromptText(v: PortValue): string {
  switch (v.kind) {
    case "text":
      return v.text;
    case "json":
      return JSON.stringify(v.json, null, 2);
    case "file":
      return `（见附件文件：${v.file.name}）`;
  }
}
