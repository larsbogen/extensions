import AppKit

// These colors inherit each view's effective appearance. No window or application
// appearance is overridden, so a running focus session follows the system theme.
enum FocusTheme {
    static func isDark(_ appearance: NSAppearance) -> Bool {
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }

    private static func color(_ name: String, light: @autoclosure @escaping () -> NSColor,
                              dark: @autoclosure @escaping () -> NSColor) -> NSColor {
        NSColor(name: NSColor.Name("TodoistFocus.\(name)")) { appearance in
            // Operations such as withAlphaComponent can resolve a system color.
            // Evaluate them lazily under the requested appearance, not whichever
            // appearance happened to be current when this static color was made.
            var resolved = NSColor.clear
            appearance.performAsCurrentDrawingAppearance {
                let selected = isDark(appearance) ? dark() : light()
                resolved = selected.usingColorSpace(.sRGB) ?? selected
            }
            return resolved
        }
    }

    private static func rgb(_ value: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255,
                green: CGFloat((value >> 8) & 0xff) / 255,
                blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }

    static let background = color("background", light: rgb(0xffffff),
                                  dark: NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.115, alpha: 1))
    static let foreground = color("foreground", light: rgb(0x242b30), dark: .labelColor)
    static let secondary = color("secondary", light: rgb(0x687478), dark: .secondaryLabelColor)
    static let accent = color("accent", light: rgb(0x28735c), dark: .systemGreen)
    static let pausedAccent = color("pausedAccent", light: rgb(0x99601f), dark: .systemOrange)
    static let track = color("track", light: rgb(0xf2f5f4), dark: NSColor.labelColor.withAlphaComponent(0.10))
    static let soft = color("soft", light: rgb(0xf2f5f4), dark: rgb(0x2b302e))
    static let primary = color("primary", light: rgb(0x273f35), dark: .systemGreen)
    static let primaryForeground = color("primaryForeground", light: .white, dark: .black)
}

// NSButton still owns target/action, keyboard handling, tracking and accessibility.
// Only its surface is drawn here, matching the quiet rounded controls in the sketch.
final class FocusActionButton: NSButton {
    enum Style { case primary, secondary, plain }
    var style: Style = .secondary { didSet { needsDisplay = true } }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        setButtonType(.momentaryPushIn)
        isBordered = false
        focusRingType = .exterior
    }

    override var title: String {
        didSet { invalidateIntrinsicContentSize(); needsDisplay = true }
    }

    override var font: NSFont? {
        didSet { invalidateIntrinsicContentSize(); needsDisplay = true }
    }

    override var intrinsicContentSize: NSSize {
        let size = (title as NSString).size(withAttributes: [.font: font ?? NSFont.systemFont(ofSize: 14, weight: .medium)])
        return NSSize(width: ceil(size.width) + 24, height: max(34, ceil(size.height) + 14))
    }

    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 9, yRadius: 9)
        if style != .plain {
            let color = style == .primary ? FocusTheme.primary : FocusTheme.soft
            color.setFill()
            shape.fill()
        }
        if cell?.isHighlighted == true {
            NSColor.labelColor.withAlphaComponent(0.08).setFill()
            shape.fill()
        }
        let color = style == .primary ? FocusTheme.primaryForeground : (contentTintColor ?? FocusTheme.foreground)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 14, weight: .medium),
            .foregroundColor: isEnabled ? color : color.withAlphaComponent(0.45),
        ]
        let text = title as NSString
        let size = text.size(withAttributes: attributes)
        text.draw(at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2), withAttributes: attributes)
    }

    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 9, yRadius: 9).fill()
    }

    override var focusRingMaskBounds: NSRect { bounds }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

// Painting the same opaque color as the window keeps controls readable above other
// apps, including in detached view rendering used by the unattended tests.
final class FocusSurfaceView: NSView {
    override var isOpaque: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        FocusTheme.background.setFill()
        NSBezierPath(rect: bounds).fill()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        refreshAppearance()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshAppearance()
    }

    private func refreshAppearance() {
        window?.backgroundColor = FocusTheme.background
        needsDisplay = true
    }
}

// Geometry is independent of session state and rendering. A missing time limit
// deliberately has no elapsed arc rather than implying a countdown target.
struct FocusRingGeometry {
    static let lineWidth: CGFloat = 5
    static let inset: CGFloat = 12
    let bounds: NSRect
    let progress: Double
    let hasTimeLimit: Bool

    var clampedProgress: Double {
        guard hasTimeLimit, progress.isFinite else { return 0 }
        return min(1, max(0, progress))
    }
    var center: NSPoint { NSPoint(x: bounds.midX, y: bounds.midY) }
    var radius: CGFloat { max(0, min(bounds.width, bounds.height) / 2 - Self.inset) }
    var ringRect: NSRect {
        NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
    }
    var startAngle: CGFloat { 90 }
    var endAngle: CGFloat { startAngle - CGFloat(clampedProgress * 360) }
    var endPoint: NSPoint {
        let radians = endAngle * .pi / 180
        return NSPoint(x: center.x + radius * cos(radians), y: center.y + radius * sin(radians))
    }
}

final class FocusRingView: NSView {
    var progress: Double = 0 { didSet { needsDisplay = true } }
    var tint: NSColor = FocusTheme.accent { didSet { needsDisplay = true } }
    var hasTimeLimit = true { didSet { needsDisplay = true } }
    var geometry: FocusRingGeometry { FocusRingGeometry(bounds: bounds, progress: progress, hasTimeLimit: hasTimeLimit) }

    override var intrinsicContentSize: NSSize { NSSize(width: 178, height: 178) }

    override func draw(_ dirtyRect: NSRect) {
        let geometry = geometry
        guard geometry.radius > 0 else { return }
        let track = NSBezierPath(ovalIn: geometry.ringRect)
        track.lineWidth = FocusRingGeometry.lineWidth
        FocusTheme.track.setStroke()
        track.stroke()

        guard geometry.clampedProgress > 0 else { return }
        tint.setStroke()
        if geometry.clampedProgress == 1 {
            track.stroke()
        } else {
            let arc = NSBezierPath()
            arc.lineWidth = FocusRingGeometry.lineWidth
            arc.lineCapStyle = .round
            arc.appendArc(withCenter: geometry.center, radius: geometry.radius,
                          startAngle: geometry.startAngle, endAngle: geometry.endAngle, clockwise: true)
            arc.stroke()
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}
