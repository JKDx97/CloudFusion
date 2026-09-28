import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ headers?: { accept?: string } }>();
    if (request.headers?.accept?.includes('text/event-stream')) return next.handle();
    return next.handle().pipe(
      map((data: unknown) => ({
        data: data ?? null,
        message: 'Operation completed successfully',
      })),
    );
  }
}
