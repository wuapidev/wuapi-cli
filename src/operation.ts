// The shape of one entry of src/generated/operations.ts.

export interface OperationField {
  name: string;
  /** A readable type: `string`, `integer`, `"a" | "b"`, `string[]`, `object`. */
  type: string;
  required: boolean;
  description: string;
}

export interface Operation {
  operationId: string;
  /** The SDK resource path: `["messages"]`, `["projects", "apiKeys"]`, `[]` for `me`. */
  resource: string[];
  /** The SDK method name. */
  method: string;
  httpMethod: string;
  path: string;
  /** Path parameters, in the order the SDK method takes them. */
  pathParams: string[];
  query: OperationField[];
  hasBody: boolean;
  bodyRequired: boolean;
  /** Body fields; several entries when the body is one of several shapes (`type`). */
  body: { name: string; fields: OperationField[] }[];
  /** The SDK method returns a Paginator. */
  paginated: boolean;
  summary: string;
  description: string;
  deprecated: boolean;
}
