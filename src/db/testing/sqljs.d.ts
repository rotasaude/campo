// The slice of sql.js the test database uses (the package ships no types).
declare module "sql.js" {
  export type SqlValue = string | number | null | Uint8Array;
  export interface Statement {
    bind(params?: SqlValue[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlValue>;
    free(): boolean;
  }
  export interface Database {
    run(sql: string, params?: SqlValue[]): Database;
    exec(sql: string): { columns: string[]; values: SqlValue[][] }[];
    prepare(sql: string): Statement;
    getRowsModified(): number;
    close(): void;
  }
  export interface SqlJsStatic { Database: new () => Database }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}
