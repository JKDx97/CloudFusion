import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = isHttpException ? exception.getResponse() : null;
    const message = this.extractMessage(exceptionResponse);
    const error = this.extractError(exceptionResponse, status);

    if (status >= 500) {
      this.logger.error(
        JSON.stringify({ event: 'http.error', status, path: request.url }),
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      error,
    });
  }

  private extractMessage(
    exceptionResponse: string | object | null,
  ): string | string[] {
    if (typeof exceptionResponse === 'string') return exceptionResponse;
    if (
      exceptionResponse &&
      typeof exceptionResponse === 'object' &&
      'message' in exceptionResponse
    ) {
      const message = (exceptionResponse as { message?: unknown }).message;
      if (typeof message === 'string' || Array.isArray(message))
        return message as string | string[];
    }
    return 'Internal server error';
  }

  private extractError(
    exceptionResponse: string | object | null,
    status: number,
  ): string {
    if (
      exceptionResponse &&
      typeof exceptionResponse === 'object' &&
      'error' in exceptionResponse
    ) {
      const error = (exceptionResponse as { error?: unknown }).error;
      if (typeof error === 'string') return error;
    }
    return status >= 500 ? 'Internal Server Error' : 'Bad Request';
  }
}
