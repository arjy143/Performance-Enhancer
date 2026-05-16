import { RemarksDiagnosticProvider } from './provider';
import { RemarkType, RemarkCategory, type OptRemark } from '../sidecar/protocol';
import * as vscode from 'vscode';

function makeRemark(overrides: Partial<OptRemark> = {}): OptRemark {
  return {
    type:     RemarkType.Missed,
    pass:     'loop-vectorize',
    name:     'UnsafeMemDep',
    file:     '/tmp/foo.cpp',
    line:     10,
    column:   0,
    function: 'foo',
    message:  'loop not vectorized',
    category: RemarkCategory.Vectorisation,
    isStale:  false,
    buildId:  'test',
    ...overrides,
  };
}

describe('RemarksDiagnosticProvider', () => {
  let requestMock: jest.Mock;
  let provider: RemarksDiagnosticProvider;
  let mockCollection: ReturnType<typeof vscode.languages.createDiagnosticCollection>;

  beforeEach(() => {
    jest.clearAllMocks();
    requestMock = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider = new RemarksDiagnosticProvider({ request: requestMock } as any);
    // Grab the collection that was handed to the provider
    mockCollection = (vscode.languages.createDiagnosticCollection as jest.Mock).mock.results[0].value as ReturnType<typeof vscode.languages.createDiagnosticCollection>;
  });

  afterEach(() => provider.dispose());

  it('calls getRemarks with the file path', async () => {
    requestMock.mockResolvedValue([]);
    const uri = vscode.Uri.file('/tmp/foo.cpp');
    await provider.refreshFile(uri);
    expect(requestMock).toHaveBeenCalledWith('getRemarks', { file: '/tmp/foo.cpp' });
  });

  it('sets diagnostics for each remark', async () => {
    const r = makeRemark({ line: 42 });
    requestMock.mockResolvedValue([r]);
    const uri = vscode.Uri.file('/tmp/foo.cpp');
    await provider.refreshFile(uri);
    expect(mockCollection.set).toHaveBeenCalledWith(
      uri,
      expect.arrayContaining([expect.objectContaining({ message: 'loop not vectorized' })]),
    );
  });

  it('maps Missed to Warning severity', async () => {
    requestMock.mockResolvedValue([makeRemark({ type: RemarkType.Missed })]);
    await provider.refreshFile(vscode.Uri.file('/tmp/foo.cpp'));
    const [, diags] = (mockCollection.set as jest.Mock).mock.calls[0] as [unknown, vscode.Diagnostic[]];
    expect(diags[0].severity).toBe(vscode.DiagnosticSeverity.Warning);
  });

  it('maps Passed to Hint severity', async () => {
    requestMock.mockResolvedValue([makeRemark({ type: RemarkType.Passed })]);
    await provider.refreshFile(vscode.Uri.file('/tmp/foo.cpp'));
    const [, diags] = (mockCollection.set as jest.Mock).mock.calls[0] as [unknown, vscode.Diagnostic[]];
    expect(diags[0].severity).toBe(vscode.DiagnosticSeverity.Hint);
  });

  it('does not throw if sidecar call fails', async () => {
    requestMock.mockRejectedValue(new Error('sidecar dead'));
    await expect(provider.refreshFile(vscode.Uri.file('/tmp/foo.cpp'))).resolves.toBeUndefined();
  });

  it('clears diagnostics for a file', () => {
    const uri = vscode.Uri.file('/tmp/foo.cpp');
    provider.clearFile(uri);
    expect(mockCollection.delete).toHaveBeenCalledWith(uri);
  });
});
