import { Injectable, MessageEvent, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Observable, Subject, defer, filter, map, merge, of, switchMap } from 'rxjs';
import { Repository } from 'typeorm';
import { TransferJob } from './entities/transfer-job.entity';

export interface TransferProgressEvent {
  transferId: string;
  status: string;
  progress: number;
  bytesTransferred: number;
  fileSize: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

@Injectable()
export class TransferProgressService {
  private readonly subjects = new Map<string, Subject<TransferProgressEvent>>();

  constructor(
    @InjectRepository(TransferJob)
    private readonly repository: Repository<TransferJob>,
  ) {}

  emit(job: TransferJob): void {
    this.subject(job.id).next(this.toEvent(job));
  }

  events(userId: string, transferId: string): Observable<MessageEvent> {
    return defer(() => this.repository.findOne({ where: { id: transferId, userId } })).pipe(
      switchMap((job) => {
        if (!job) throw new NotFoundException('TRANSFER_NOT_FOUND');
        const updates = this.subject(transferId).asObservable().pipe(
          filter((event) => event.transferId === transferId),
          map((data) => ({ data })),
        );
        return merge(of({ data: this.toEvent(job) }), updates);
      }),
    );
  }

  private subject(id: string): Subject<TransferProgressEvent> {
    let subject = this.subjects.get(id);
    if (!subject) {
      subject = new Subject<TransferProgressEvent>();
      this.subjects.set(id, subject);
    }
    return subject;
  }

  private toEvent(job: TransferJob): TransferProgressEvent {
    return {
      transferId: job.id,
      status: job.status,
      progress: job.progress,
      bytesTransferred: Number(job.bytesTransferred ?? 0),
      fileSize: job.fileSize == null ? null : Number(job.fileSize),
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
    };
  }
}
