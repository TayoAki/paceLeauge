describe('toolchain', () => {
  it('runs TypeScript tests', () => {
    const total: number = [1, 2, 3].reduce((a, b) => a + b, 0);
    expect(total).toBe(6);
  });
});
