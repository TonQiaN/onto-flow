/** 文件类对象类型可声明的输入预处理器。null 表示原样物化。 */
export const FILE_PREPROCESSORS = ["pdf"] as const;

export type FilePreprocessor = (typeof FILE_PREPROCESSORS)[number];

