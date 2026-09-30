import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { PairDeviceDto } from './dto/pair-device.dto';
import { AccessTokenGuard } from './guards/access-token.guard';
import type { AuthenticatedRequest } from './types/authenticated-request';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a user' })
  @ApiResponse({
    status: 201,
    description: 'User registered and tokens issued',
  })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Authenticated user and tokens' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Invalidate the current session' })
  logout(@Req() request: AuthenticatedRequest) {
    return this.authService.logout(request.user.sub, request.user.deviceId);
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the authenticated user' })
  me(@Req() request: AuthenticatedRequest) {
    return this.authService.me(request.user.sub);
  }

  @Post('device-pairing-codes')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a short-lived, one-time code to pair a headless CloudFusion node' })
  createDevicePairingCode(@Req() request: AuthenticatedRequest) {
    return this.authService.createDevicePairingCode(request.user.sub);
  }

  @Post('device-pair')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @ApiOperation({ summary: 'Exchange a one-time pairing code for a device-bound CloudFusion session' })
  pairDevice(@Body() dto: PairDeviceDto) {
    return this.authService.pairDevice(dto);
  }
}
