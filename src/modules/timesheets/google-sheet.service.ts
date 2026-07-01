import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

@Injectable()
export class GoogleSheetService implements OnModuleInit {
  private readonly logger = new Logger(GoogleSheetService.name);
  private sheetsClient: any;
  private spreadsheetId!: string;
  private tabName!: string;
  private sheetIdCache: number | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    await this.initialize();
  }

  async initialize() {
    if (this.sheetsClient) {
      return;
    }

    const serviceAccountEmail = this.configService.get<string>('GOOGLE_SA_CLIENT_EMAIL');
    const serviceAccountKeyRaw = this.configService.get<string>('GOOGLE_SA_PRIVATE_KEY');
    this.spreadsheetId = (
      this.configService.get<string>('GOOGLE_SHEETS_TIMESHEET_ID') ??
      this.configService.get<string>('GOOGLE_SHEETS_SPREADSHEET_ID') ??
      ''
    ).trim();
    this.tabName = (
      this.configService.get<string>('GOOGLE_SHEETS_TIMESHEET_TAB') || 'Timesheet Export'
    ).trim();

    if (!this.spreadsheetId) {
      throw new Error('Missing GOOGLE_SHEETS_TIMESHEET_ID');
    }
    if (!serviceAccountEmail) {
      throw new Error('Missing GOOGLE_SA_CLIENT_EMAIL');
    }
    if (!serviceAccountKeyRaw) {
      throw new Error('Missing GOOGLE_SA_PRIVATE_KEY');
    }

    try {
      const serviceAccountKey = serviceAccountKeyRaw.replace(/\\n/g, '\n');
      const jwtClient = new google.auth.JWT({
        email: serviceAccountEmail,
        key: serviceAccountKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.sheetsClient = google.sheets({ version: 'v4', auth: jwtClient as any });
      this.logger.log(
        `Google Sheets initialized: sheet=${this.tabName}, spreadsheet=${this.spreadsheetId}`,
      );
    } catch (error: any) {
      this.logger.error('Failed to initialize Google Sheets client:', error);
      throw error;
    }
  }

  async readRows(): Promise<any[][]> {
    if (!this.sheetsClient) {
      this.logger.warn('Google Sheets client not initialized.');
      return [];
    }
    try {
      const res = await this.sheetsClient.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${this.tabName}'!A:H`,
      });
      return res.data.values ?? [];
    } catch (error) {
      this.logger.error(`Error reading rows from range '${this.tabName}'!A:H:`, error);
      throw error;
    }
  }

  async appendRow(values: any[]): Promise<void> {
    if (!this.sheetsClient) {
      this.logger.warn('Google Sheets client not initialized.');
      return;
    }
    try {
      await this.sheetsClient.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `'${this.tabName}'!A:H`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [values],
        },
      });
      this.logger.log(`Row appended successfully to Google Sheet.`);
    } catch (error) {
      this.logger.error(`Error appending row:`, error);
      throw error;
    }
  }

  async updateRow(rowIndex: number, values: any[]): Promise<void> {
    if (!this.sheetsClient) {
      this.logger.warn('Google Sheets client not initialized.');
      return;
    }
    try {
      const rowNum = rowIndex + 1;
      await this.sheetsClient.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `'${this.tabName}'!A${rowNum}:H${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [values],
        },
      });
      this.logger.log(`Row ${rowNum} updated successfully in Google Sheet.`);
    } catch (error) {
      this.logger.error(`Error updating row ${rowIndex + 1}:`, error);
      throw error;
    }
  }

  private async getSheetId(): Promise<number> {
    if (this.sheetIdCache !== null) {
      return this.sheetIdCache;
    }
    if (!this.sheetsClient) {
      throw new Error('Google Sheets client not initialized.');
    }
    try {
      const spreadsheet = await this.sheetsClient.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });
      const sheet = spreadsheet.data.sheets.find(
        (s: any) => s.properties.title === this.tabName,
      );
      if (!sheet || sheet.properties.sheetId === undefined) {
        throw new Error(`Sheet tab "${this.tabName}" not found or sheetId is missing.`);
      }
      this.sheetIdCache = sheet.properties.sheetId;
      return this.sheetIdCache!;
    } catch (error) {
      this.logger.error(`Error fetching sheet ID for tab "${this.tabName}":`, error);
      throw error;
    }
  }

  async deleteRow(rowIndex: number): Promise<void> {
    if (!this.sheetsClient) {
      this.logger.warn('Google Sheets client not initialized.');
      return;
    }
    try {
      const sheetId = await this.getSheetId();
      await this.sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId,
                  dimension: 'ROWS',
                  startIndex: rowIndex,
                  endIndex: rowIndex + 1,
                },
              },
            },
          ],
        },
      });
      this.logger.log(`Row index ${rowIndex} deleted successfully from Google Sheet.`);
    } catch (error) {
      this.logger.error(`Error deleting row at index ${rowIndex}:`, error);
      throw error;
    }
  }

  async findRows(
    predicate: (row: any[], index: number) => boolean,
  ): Promise<{ row: any[]; index: number }[]> {
    try {
      const rows = await this.readRows();
      const results: { row: any[]; index: number }[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (predicate(rows[i], i)) {
          results.push({ row: rows[i], index: i });
        }
      }
      return results;
    } catch (error) {
      this.logger.error(`Error finding rows:`, error);
      return [];
    }
  }
}
