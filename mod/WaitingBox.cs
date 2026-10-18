using System;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using Microsoft.Xna.Framework.Input;
using StardewValley;
using StardewValley.Menus;

namespace Townsfolk;

/// <summary>
/// The box shown from the click until the reply arrives, and between turns after a pick: the
/// NPC's portrait and name with dots that cycle, in the same frame as the game's own dialogue.
/// It is an active menu, so the player cannot walk away and single-player time stops the way it
/// does in vanilla dialogue (in multiplayer the game does not pause; the box simply stays up).
/// Escape or the back button closes it, which ends the conversation.
/// </summary>
public sealed class WaitingBox : IClickableMenu
{
    private readonly NPC npc;

    public WaitingBox(NPC npc)
    {
        this.npc = npc;
    }

    /// <summary>True once the player closed the box themselves (Escape or back).</summary>
    public bool UserClosed { get; private set; }

    public override void receiveKeyPress(Keys key)
    {
        if (Game1.options.doesInputListContain(Game1.options.menuButton, key))
            this.Close();
    }

    public override void receiveGamePadButton(Buttons b)
    {
        if (b == Buttons.B)
            this.Close();
    }

    public override void receiveLeftClick(int x, int y, bool playSound = true)
    {
    }

    public override void receiveRightClick(int x, int y, bool playSound = true)
    {
    }

    private void Close()
    {
        this.UserClosed = true;
        this.exitThisMenu(false);
    }

    public override void draw(SpriteBatch b)
    {
        int width = Math.Min(1200, Game1.uiViewport.Width - 64);
        const int height = 320;
        int x = (Game1.uiViewport.Width - width) / 2;
        int y = Game1.uiViewport.Height - height - 64;
        Game1.drawDialogueBox(x, y, width, height, false, true);

        const int portrait = 256;
        if (this.npc.Portrait is { } sheet)
        {
            b.Draw(sheet, new Rectangle(x + 40, y + 32, portrait, portrait), Game1.getSourceRectForStandardTileSheet(sheet, 0, 64, 64), Color.White);
        }
        int textX = x + 40 + portrait + 40;
        Utility.drawTextWithShadow(b, this.npc.displayName, Game1.dialogueFont, new Vector2(textX, y + 48), Game1.textColor);
        string dots = new('.', TalkWait.DotsAt(Environment.TickCount64));
        Utility.drawTextWithShadow(b, dots, Game1.dialogueFont, new Vector2(textX, y + 48 + 96), Game1.textColor);
        this.drawMouse(b);
    }
}
